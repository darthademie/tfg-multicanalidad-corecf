const logger = require("firebase-functions/logger");
const functions = require('firebase-functions');

// 1. Importamos e inicializamos firebase-admin para tener acceso a toda la BD
const admin = require('firebase-admin');
admin.initializeApp();

//////////////////////////////////////////////////////////////////////////////////////
//////////// FUNCIONES REACTIVAS A FIREBASE AUTH /////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////

// Función 1: Bienvenida al registrarse
exports.procesarRegistroUsuario = functions.auth.user().onCreate(async (user) => {
    const uid = user.uid;
    const email = user.email;

    logger.info(`Nuevo usuario registrado en Auth: ${uid} - ${email}`);

    try {
        // Encolamos el evento en la RTDB para que lo procese la función de emails
        const emailData = {
            uid_fb: uid,
            code: "registro_usuario",
            email: email
        };

        await admin.database().ref('cola_procesamiento/emails').push(emailData);
        logger.info(`Evento de bienvenida encolado para el usuario ${uid}.`);

        return null;

    } catch (error) {
        logger.error("Error al encolar el evento de bienvenida:", error);
        return null;
    }
});

// Función 2: Limpieza y despedida al eliminar cuenta
exports.limpiarDatosUsuario = functions.auth.user().onDelete(async (user) => {
    const uid = user.uid;
    const email = user.email;

    logger.info(`Usuario eliminado de Auth: ${uid}. Procediendo a limpieza...`);

    try {
        // 1. Enviar evento a la cola de emails para el correo de despedida
        const emailData = {
            uid_fb: uid,
            code: "cuenta_eliminada",
            email: email // Lo pasamos directamente de Firebase Auth por si el nodo de BBDD ya se borró
        };
        
        await admin.database().ref('cola_procesamiento/emails').push(emailData);
        logger.info(`Evento de despedida encolado para el usuario ${uid}.`);

        // 2. Limpiar el nodo del usuario en Realtime Database
        await admin.database().ref(`/usuarios/${uid}`).remove();
        logger.info(`Nodo de Realtime Database (/usuarios/${uid}) eliminado correctamente.`);

        return null;

    } catch (error) {
        logger.error(`Error durante la limpieza del usuario ${uid}:`, error);
        return null;
    }
});

//////////////////////////////////////////////////////////////////////////////////////
//////////// FUNCIONES REACTIVAS A CAMBIOS EN LA RTDB ////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////

// Función 1: Procesamiento de pedidos de usuario centralizado para la gestión de TeleUPM
exports.procesarPedidos = functions.database.ref('/cola_procesamiento/pedidos/{nodo}')
  .onCreate(async (snapshot, context) => {
      const data = snapshot.val();
      logger.info("Nuevo pedido recibido en la cola:", data);

      // Si el origen del pedido es Telegram, ejecutamos la lógica
      if (data.type === "telegram") {
          const telegramId = data.user_id;

          // Paso 1: Buscar el id_firebase_usuario correspondiente a ese telegramId
          const telegramRef = admin.database().ref('/telegram');
          const userSnapshot = await telegramRef.orderByValue().equalTo(telegramId).once('value');

          // Verificamos si existe un usuario vinculado
          if (!userSnapshot.exists()) {
              logger.error(`No se encontró un usuario de Firebase vinculado al Telegram ID: ${telegramId}`);
              return null; // Abortamos la ejecución limpiamente
          }

          // Extraemos el Firebase UID (será la clave del objeto devuelto)
          const firebaseUid = Object.keys(userSnapshot.val())[0];
          logger.info(`Usuario mapeado correctamente. Firebase UID: ${firebaseUid}`);

          // Paso 2: Procesar e inyectar según el tipo de pedido
          if (data.order_type === "device") {
              const nombreDispositivo = data.device_model;
              const color = data.color;
              const almacenamiento = data.storage;
              
              const pedidoFormateado = {
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

              // Inyectamos el dispositivo en la rama de pedidos físicos
              await admin.database().ref(`/usuarios/${firebaseUid}/pedidos`).push(pedidoFormateado);
              logger.info(`Pedido de dispositivo inyectado con éxito en /usuarios/${firebaseUid}/pedidos`);

          } else {
              // Extraemos el código de la tarifa que envía el bot de Telegram
              const codigoTarifa = data.plan;

              if (!codigoTarifa) {
                  logger.error("No se encontró el código de la tarifa en el paquete de la cola:", data);
                  return null;
              }

              // Al hacer push de un string directo, Firebase crea la clave tipo "-P4L7pma..." 
              // y le asigna directamente el valor como "pack_conecta_1g"
              await admin.database().ref(`/usuarios/${firebaseUid}/tarifas`).push(codigoTarifa);
              logger.info(`Tarifa '${codigoTarifa}' inyectada con éxito en /usuarios/${firebaseUid}/tarifas`);
          }

          // Paso 3: Borrar el pedido de la cola tras procesarlo
          await snapshot.ref.remove();
      }

      return null;
  });

  // Función 2: Procesamiento de ofertas. Si la compra de un dispositivo o tarifa tiene
  // oferta, se le notificará al usuario por Telegram
exports.procesarOfertas = functions.database.ref('/cola_procesamiento/ofertas/{tareaId}')
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

    // 5. Transformamos el campo origin según el canal de entrada
    let originTransformado;
    switch (originEntrada?.trim().toLowerCase()) {
      case 'web':
        originTransformado = "Gestión de pedidos web de TeleUPM";
        break;
      case 'mobile':
        originTransformado = "TeleUPM";
        break;
      default:
        originTransformado = originEntrada;
        break;
    }
    

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

// Función 3: Procesamiento de emails. Una aplicación puede solicitar mandarle un email
// al usuario según sus circunstancias y lo que tenga N8N admitido
exports.procesarColaEmails = functions.database.ref('/cola_procesamiento/emails/{pushId}')
  .onCreate(async (snapshot, context) => {
    
    // 1. Extraemos los datos que acaban de entrar
    const data = snapshot.val();
    const uid_fb = data.uid_fb;
    const code = data.code;

    if (!uid_fb || !code) {
      console.error("Faltan datos en el nodo de la cola:", data);
      return null;
    }

    try {
      // 2. Extraer datos si vienen directos (ej: desde los triggers de auth o app).
      // Si no vienen, se buscan en la RTDB.
      let emailDestino = data.email;
      let nameDestino = data.name;

      if (!emailDestino) {
        const emailRef = admin.database().ref(`/usuarios/${uid_fb}/email`);
        const emailSnapshot = await emailRef.once('value');
        emailDestino = emailSnapshot.val();
      }

      if (!nameDestino) {
        const nameRef = admin.database().ref(`/usuarios/${uid_fb}/nombre`);
        const nameSnapshot = await nameRef.once('value');
        nameDestino = nameSnapshot.val();
      }

      if (!emailDestino) {
        console.error(`No se encontró la propiedad 'email' para el usuario: ${uid_fb}`);
        return null;
      }

      if (!nameDestino) {
        console.warn(`No se encontró la propiedad 'name' para el usuario: ${uid_fb}. Enviando vacío...`);
        nameDestino = ""; // Fallback para correos que no necesitan nombre
      }

      // 3. Preparamos el objeto final para n8n
      const payloadWebhook = {
        code: code,
        email: emailDestino,
        name: nameDestino
      };

      // 4. Hacemos el salto externo hacia tu clúster (aquí pondrás la URL de ngrok para probar)
      const N8N_WEBHOOK_URL = 'https://pluck-treadmill-stony.ngrok-free.dev/flujos/webhook/email-webhook';
      
      console.log(`Enviando webhook a n8n para el usuario ${emailDestino} con código ${code}...`);
      
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payloadWebhook)
      });

      if (!response.ok) {
        throw new Error(`n8n devolvió un error: ${response.status} ${response.statusText}`);
      }

      console.log("Webhook procesado correctamente por N8N.");

      // 5. Borramos el nodo de la cola para que no ocupe espacio
      await snapshot.ref.remove();

      return null;

    } catch (error) {
      // Aquí caerán los timeouts si Windows/Podman están apagados o ngrok está caído
      console.error("Error crítico al procesar o enviar el webhook:", error);
      return null;
    }
  });

//////////////////////////////////////////////////////////////////////////////////////
//////////// FUNCIONES DE TIPO BACKEND ///////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getAuth } = require("firebase-admin/auth");

// Función 1: Permite obtener el uid de firebase de un usuario a partir de
// su correo (El registrado en Firebase Auth)
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