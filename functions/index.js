const logger = require("firebase-functions/logger");
const functions = require('firebase-functions');

// 1. Importamos e inicializamos firebase-admin para tener acceso a toda la BD
const admin = require('firebase-admin');
admin.initializeApp();

//////////////////////////////////////////////////////////////////////////////////////
//////////// FUNCIONES REACTIVAS A CAMBIOS EN LA RTDB ////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////

exports.procesarPedidos = functions.database.ref('/cola_procesamiento/pedidos/{nodo}')
    .onCreate(async (snapshot, context) => {
        const data = snapshot.val();
        logger.info("Nuevo pedido recibido en la cola:", data); // Sustituto correcto de print() en Node.js

        // Si el origen del pedido es Telegram, ejecutamos la lógica
        if (data.type === "telegram") {
            const telegramId = data.user_id;

            // Paso 1: Buscar el id_firebase_usuario correspondiente a ese telegramId
            const telegramRef = admin.database().ref('/telegram');
            // Buscamos en el mapeo aquel cuyo valor coincida con el ID de Telegram
            const userSnapshot = await telegramRef.orderByValue().equalTo(telegramId).once('value');

            // Verificamos si existe un usuario vinculado
            if (!userSnapshot.exists()) {
                logger.error(`No se encontró un usuario de Firebase vinculado al Telegram ID: ${telegramId}`);
                return null; // Abortamos la ejecución limpiamente
            }

            // Extraemos el Firebase UID (será la clave del objeto devuelto)
            const firebaseUid = Object.keys(userSnapshot.val())[0];
            logger.info(`Usuario mapeado correctamente. Firebase UID: ${firebaseUid}`);

            // Paso 2: Generar el objeto final con los textos formateados
            let pedidoFormateado = {};

            if (data.order_type === "device"){
              const nombreDispositivo = data.device_model;
              const color = data.color;
              const almacenamiento = data.storage;
              pedidoFormateado = {
                  descripcion: `Pedido realizado a través de Telegram - Opciones de personalización: Color: ${color}, Capacidad: ${almacenamiento}`,
                  estado: [
                      { codEstado: 2, descripcion: "Pedido anotado en empresa de paquetería" },
                      { codEstado: 0, descripcion: "" },
                      { codEstado: 0, descripcion: "" },
                      { codEstado: 0, descripcion: "" },
                      { codEstado: 0, descripcion: "" }
                  ],
                  nombre: `Oferta ${nombreDispositivo}`
              };
            }
            else {
              // Hacer parte de tarifas!!!
              pedidoFormateado = {
                  descripcion: `Pedido de tarifa x realizado a través de Telegram`,
                  estado: [
                      { codEstado: 2, descripcion: "Pedido anotado" },
                      { codEstado: 0, descripcion: "" },
                      { codEstado: 0, descripcion: "" },
                      { codEstado: 0, descripcion: "" },
                      { codEstado: 0, descripcion: "" }
                  ],
                  nombre: `Oferta ${nombreDispositivo}`
              };
            }

            // Paso 3: Hacer push al nodo de pedidos del usuario
            await admin.database().ref(`/usuarios/${firebaseUid}/pedidos`).push(pedidoFormateado);
            
            logger.info(`Pedido inyectado con éxito en /usuarios/${firebaseUid}/pedidos`);
            
            // Opcional pero recomendado: borrar el pedido de la cola tras procesarlo
            await snapshot.ref.remove();
        }

        return null; // Las funciones 'background' de Firebase siempre deben retornar una Promesa o un valor
});

exports.procesadorDeOfertas = functions.database.ref('/cola_procesamiento/ofertas/{tareaId}')
  .onCreate(async (snapshot, context) => {
    
    // 1. Extraemos los datos de entrada según la estructura de la cola
    const tarea = snapshot.val();
    const claveComprada = tarea.name; // Ej: "pocophone_f6"
    const originEntrada = tarea.origin; // Ej: "web"
    const uidFb = tarea.uid_fb;         // Ej: "xSGvcOK..."
    
    const db = admin.database();

    try {
      // 2. Buscamos si existe alguna oferta disponible para el dispositivo/tarifa comprado
      const ofertasDispRef = db.ref('ofertas_disponibles');
      const ofertasQuery = await ofertasDispRef.orderByChild('origin').equalTo(claveComprada).once('value');

      // Si no hay oferta para este producto, borramos la tarea de la cola y terminamos
      if (!ofertasQuery.exists()) {
        console.log(`No hay ofertas configuradas para el origen: ${claveComprada}`);
        await snapshot.ref.remove();
        return null;
      }

      // Extraemos la primera oferta que coincida
      const ofertaKey = Object.keys(ofertasQuery.val())[0];
      const ofertaData = ofertasQuery.val()[ofertaKey];

      // 3. Obtenemos el chat_id de Telegram del usuario
      const telegramRef = await db.ref(`telegram/${uidFb}`).once('value');
      const chatId = telegramRef.val();

      // Si el usuario no ha vinculado Telegram, no podemos enviarle la oferta
      if (!chatId) {
        console.log(`El usuario ${uidFb} no tiene chat_id de Telegram vinculado.`);
        await snapshot.ref.remove();
        return null;
      }

      // 4. Resolvemos el nombre completa del producto objetivo y su clave de tarifa (Target)
      let nombreTarget = "Oferta Especial";
      let tarifaTaget = "tarifa";
      if (ofertaData.type === 'device') {
        const dispRef = await db.ref(`dispositivos/${ofertaData.target}`).once('value');
        if (dispRef.exists()) nombreTarget = dispRef.val();
      } else if (ofertaData.type === 'plan') {
        const tarifaRef = await db.ref(`tarifas/${ofertaData.target}/nombre`).once('value');
        if (tarifaRef.exists()) {
          tarifaTaget = ofertaData.target;
          nombreTarget = tarifaRef.val();
        }
      }

      // 5. Transformamos el campo origin si viene de la web
      const originTransformado = originEntrada === 'web' ? 'Gestión de pedidos web de TeleUPM' : originEntrada;

      // 6. Construimos el objeto de salida con la estructura exacta requerida
      const nuevaOfertaTelegram = {
        chat_id: chatId,
        discount: ofertaData.discount,
        name: nombreTarget,
        plan: tarifaTaget,
        origin: originTransformado,
        processed: false, // Siempre a false, lo procesará el bot de Python
        type: ofertaData.type
      };

      // 7. Escribimos la oferta en el nodo definitivo para que la consuma Telegram
      await db.ref('ofertas').push(nuevaOfertaTelegram);

      // 8. Limpiamos la cola eliminando la tarea procesada
      await snapshot.ref.remove();
      
      console.log(`[INFO] Oferta de ${ofertaData.discount}% en ${nombreTarget} generada para UID: ${uidFb}`);
      return null;

    } catch (error) {
      console.error("[ERROR] Error interno procesando la oferta:", error);
      // En caso de fallo crítico, no borramos la tarea de la cola para poder depurarla
      return null; 
    }
  });

//////////////////////////////////////////////////////////////////////////////////////
//////////// FUNCIONES DE TIPO BACKEND ///////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getAuth } = require("firebase-admin/auth");

exports.obtenerUidPorCorreo = onCall(async (request) => {
  // 1. Verificación estricta de seguridad (Zero Trust)
  // Comprobar que el usuario está autenticado y posee el Custom Claim 'admin'
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError(
      'permission-denied',
      'Operación denegada. Solo los administradores pueden buscar usuarios.'
    );
  }

  // 2. Extraer el parámetro enviado desde Angular
  const emailBuscado = request.data.email;

  if (!emailBuscado) {
    throw new HttpsError('invalid-argument', 'El formato del correo es inválido o está vacío.');
  }

  try {
    // 3. Usar el Admin SDK para buscar al usuario de forma segura
    const userRecord = await getAuth().getUserByEmail(emailBuscado);
    
    // 4. Devolver el UID
    return { uid: userRecord.uid };
    
  } catch (error) {
    // Si el correo no existe en la base de datos de Firebase Auth
    if (error.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'No se ha encontrado ningún usuario con este correo.');
    }
    
    console.error("Error buscando usuario:", error);
    throw new HttpsError('internal', 'Error interno del servidor al buscar el usuario.');
  }
});