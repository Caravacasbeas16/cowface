# CowFace

Marketplace de ropa, zapatos, bolsos y accesorios, nuevos y usados, para Costa Rica,
al estilo de Grailed: compras al precio publicado o haces una oferta, y todo el trato pasa
por un chat en vivo que no deja compartir teléfonos, redes sociales ni enlaces.

## Arrancar en tu computadora

Requiere Node.js 22.13 o más nuevo.

```bash
npm install
npm run seed      # crea la cuenta admin y datos de demostración
npm run dev       # abre http://localhost:3100
```

- Cuentas de demostración (admin, 4 vendedores y una compradora con un chat de ejemplo):
  ver el encabezado de `src/seed.js`.
- `npm run seed -- --reset` borra todo y vuelve a crear la demostración.
- `npm test` corre las pruebas.
- Si tienes una base de datos de la versión anterior (sin chat), borra la carpeta `data/` y corre el seed.

## Cómo funciona un trato (pago protegido, como Grailed)

1. Cualquier usuario (una sola cuenta para comprar y vender) abre un artículo y puede
   **Comprar ahora**, **Hacer oferta** (mínimo 50 % del precio; el vendedor acepta, rechaza o
   contraoferta; vence en 48 h) o **Preguntar** en el chat.
2. Al comprar o aceptar una oferta se crea el pedido `CF-XXXXXX` **por pagar** y se reserva el artículo.
3. El comprador paga **a CowFace** por SINPE Móvil (número que configuras en `/admin`) con el código
   como detalle, y toca **Ya pagué** con el comprobante y los datos de entrega. Si no paga en el plazo
   (24 h por defecto), el pedido se cancela solo.
4. En `/admin → Por hacer` verificas el SINPE en tu banco y tocas **Pago recibido**. Recién ahí el
   vendedor ve la dirección y envía.
5. El vendedor marca **Enviado**. El comprador toca **Lo recibí**, o pasa el plazo (3 días por defecto)
   sin reclamo y se completa solo.
6. En `/admin → Pagos a vendedores` ves cuánto transferir (precio − 2 % + envío) y a qué SINPE; al hacerlo,
   tocas **Ya le pagué**.
7. Si hay problema, el comprador abre un **reclamo** y el dinero queda retenido; tú decides
   **Pagar al vendedor** o **Reembolsar al comprador**.

Los plazos y el porcentaje se cambian en `/admin → Cobro`. Cada pedido guarda la comisión con la que se creó.

## Filtro del chat

`src/moderation.js` bloquea, antes de que la venta exista:

- Palabras de la lista (WhatsApp, Facebook, Messenger, Instagram, Telegram…), aunque vengan
  disfrazadas: `w h a t s a p p`, `f4ceb00k`, `face-book`. La lista se edita en `/admin`.
- Teléfonos (`8888-8888`, `+506 8888 8888`, `8 8 8 8…`), correos (también `arroba … punto`)
  y enlaces.

También revisa títulos y descripciones de artículos y nombres de tienda. Cada intento
bloqueado queda en `/admin → Intentos bloqueados`.

## Publicar en Railway

1. En Railway: **New Project → Deploy from GitHub repo** → elige este repositorio.
2. En el servicio: clic derecho → **Attach volume**, montado en `/data`. Ahí viven la base de
   datos y las fotos; sin volumen se borran en cada publicación.
3. Pestaña **Variables**:
   - `NODE_ENV` = `production`
   - `ADMIN_EMAIL` = tu correo
   - `ADMIN_PASSWORD` = una contraseña de 12+ caracteres (escríbela solo ahí)
   - `CONTACT_EMAIL` = correo que aparece en términos y privacidad
4. **Settings → Networking → Generate Domain** para tener una dirección `.up.railway.app`,
   o **Custom Domain** para tu dominio propio.

Después de publicar, entra a `/admin → Cobro` y pon tu número SINPE Móvil y el titular: sin eso nadie puede comprar.

Cada `git push` a `main` vuelve a publicar solo. Corre en **un solo servidor** (réplicas = 1):
el chat en vivo, los límites de intentos y las tareas automáticas viven en ese proceso.

## Fotos

- Hasta **8 fotos** por artículo (mínimo 1), de hasta **20 MB** cada una: JPG, PNG, WebP o AVIF.
  HEIC (iPhone) muestra cómo cambiarlo; los iPhone suelen convertir a JPG solos al subir desde el navegador.
- `src/images.js` (con `sharp`) endereza la foto según el celular, **borra los metadatos y la
  ubicación GPS**, y guarda tres versiones:
  - **original**: resolución completa. Si es un JPG derecho, solo se le quitan los metadatos y los
    datos de imagen quedan **byte por byte iguales** (no se vuelve a comprimir). Si hay que
    enderezarla, se guarda en JPEG calidad 95 sin submuestreo de color (PNG queda sin pérdida);
  - **grande** de 2048 px (calidad 90, 4:4:4) para la página del artículo;
  - **miniatura** de 800 px para las tarjetas, para que el catálogo cargue rápido.
- La pantalla completa (zoom) usa la original. Las fotos chicas no se agrandan; menos de 300 px se rechaza.
- El formulario de publicar (`public/js/listing.js`) permite arrastrar varias fotos, verlas,
  reordenarlas, elegir la portada y ver el progreso de subida.
- **Importar desde PDF** (`public/js/pdf-import.js`, con pdf.js servido desde `/vendor/pdfjs`):
  el navegador convierte cada página del catálogo de la tienda en una foto de ~2400 px y el
  vendedor escoge cuáles usar. No se sube el PDF.
- **Instagram no se importa**: sin iniciar sesión, Instagram solo entrega la primera foto a 640 px
  y cambia seguido. Lo correcto es subir las fotos originales desde la galería del celular.

## Publicar: borradores, medidas y envío

- **Guardar borrador** no necesita fotos y nadie más lo ve; se publica después desde "Editar".
- Medidas por categoría (pecho, largo, plantilla, alto…), en cm.
- El vendedor pone el **costo de envío** (0 = gratis) y si acepta **entrega en persona** (sin costo de envío).
  El comprador ve el total exacto antes de comprar; al vendedor se le paga precio − 2 % + envío.
- En el panel: editar precio y cantidad sin abrir el artículo (cantidad 0 lo marca vendido).

## Chat: fotos y comprobantes

- En el chat se adjuntan fotos (JPG/PNG/WebP/AVIF) o PDF de hasta 10 MB. Se guardan **fuera** de
  la carpeta pública (`attachments/` en el volumen) y `/adjuntos/<archivo>` solo los entrega a las
  dos personas de la conversación y al admin. Las fotos pierden sus metadatos.
- Al pagar, enviar o reclamar se puede subir la captura del SINPE, la foto de la guía o la evidencia.
  Para marcar **Enviado** hace falta número de guía o foto (salvo entrega en persona).
- El texto del mensaje pasa por el filtro, pero **el filtro no lee texto dentro de las fotos**.
- El admin puede leer cualquier conversación en `/admin/conversaciones/<id>` para resolver reclamos.

## Avisos de búsqueda

En una búsqueda (con o sin resultados) el botón **Avísame cuando haya** la guarda (máximo 20 por
persona). Al publicarse algo que coincide se manda un correo (Brevo), como máximo uno cada 6 horas
por búsqueda. Se borran desde el panel. `/como-funciona` explica plazos, envíos y reclamos.

## Búsqueda

`src/search-text.js` arma para cada artículo un texto sin tildes ni mayúsculas con título, marca
(también junta: "rayban"), tipo, color, talla, categoría, para quién y estado. La búsqueda va por
inicio de palabra, en singular ("camisas" → "camisa") y con sinónimos de Costa Rica (tenis/zapatillas,
suéter/hoodie/buzo, lentes/gafas, pantalones → también jeans). Una talla de letra ("m", "xl") busca
esa talla. Lo unisex aparece en mujer y hombre, no en niños. Si el mínimo es mayor que el máximo se
invierten. La barra de arriba sugiere categorías, tipos y marcas mientras se escribe
(`/buscar/sugerencias`).

## Notificaciones en el celular (Web Push)

- En Mi cuenta → "Notificaciones en el celular" cada persona las activa en cada dispositivo.
  Llegan cuando le escriben, le hacen una oferta o cambia un pedido; tocar la notificación abre la
  conversación. `public/sw.js` las recibe aunque la página esté cerrada.
- Android y computadora: Chrome, Edge o Firefox. **iPhone (iOS 16.4+)**: solo si se agrega CowFace a
  la pantalla de inicio (Safari → Compartir → Agregar a pantalla de inicio) y se abre desde ese ícono;
  la página lo explica paso a paso.
- Las claves VAPID se crean solas la primera vez y se guardan en la base (no hay que configurar
  nada). Para fijarlas, `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` en Railway. Si cambian, cada quien
  tiene que volver a activarlas.
- Solo se aceptan direcciones de los servicios de notificaciones de Google, Apple, Mozilla y Microsoft.
- El menú en el celular es de hamburguesa (☰), con el ícono de mensajes y su contador a la vista.

## Respaldos

- Todos los días (`src/backup.js`): copia de la base en el volumen (`/data/backups`, las últimas 7),
  sin sesiones ni enlaces de contraseña.
- Si está `BACKUP_PASSWORD` (12+ caracteres) en Railway → Variables, esa copia se cifra (AES-256) y
  llega por correo al admin: es la que sobrevive si se pierde el volumen. Sin esa contraseña no se
  puede abrir: guárdala aparte.
- `/admin → Respaldos`: hacer uno ahora, descargar las copias del día, o **"Descargar todo"**
  (.tar.gz con la base, las fotos y los adjuntos). Conviene bajarlo una vez al mes.
- Restaurar: `node scripts/restore-backup.mjs archivo.cfbk` (o `.db.gz`) deja `cowface-restaurado.db`.
  Para volver a ponerla en Railway: detener el servicio, reemplazar `/data/db/cowface.db` por ese
  archivo (y descomprimir `uploads/` y `attachments/` del respaldo completo en `/data`), y arrancar.

## Vista previa al compartir

Cada artículo y cada perfil tiene etiquetas Open Graph: al pegar el enlace en WhatsApp, Instagram o
Facebook sale la foto, el nombre, el precio y la talla. Las direcciones salen de `PUBLIC_URL` o del
dominio de Railway; si se cambia a dominio propio, definir `PUBLIC_URL`.

## Carga rápida de tiendas

- `/admin → + Crear tienda`: crea la cuenta (con su SINPE) y le manda por correo un enlace para que
  ponga su contraseña (vence en 72 horas).
- `/admin → Cargar artículos` (en la fila de la tienda): un CSV de Excel o Google Sheets + las fotos
  (hasta 60 por carga, 200 artículos por CSV). Hay plantilla para descargar. Acepta valores como los
  escribe una persona ("Zapatos", "niños", "9" → US 9, "32" en jeans → Cintura 32). Las filas con
  errores no se crean y se explica por qué; las que no tienen fotos quedan como borrador.
- **Ventas y reseñas previas** (en la fila de la tienda): el historial de antes de CowFace (por
  ejemplo de Instagram). Se suma a lo que haga en CowFace, que se va agregando solo, y el perfil
  aclara cuánto es previo y de dónde viene.
- `/tiendas`: directorio público con cada tienda, sus ventas, reseñas y artículos a la venta.
- **Datos por enviar a tiendas** (en "Por hacer"): después de confirmar el SINPE, el admin le manda
  a la tienda por correo los datos de entrega (o los copia para WhatsApp y los marca como enviados).

## Entrega "como un Uber"

El artículo no lleva costo de envío: solo dice si la tienda ofrece pick up. Después de comprar:
1. El comprador elige **Correos de Costa Rica**, **Uber Flash** o **pick up** y da la dirección
   (`POST /pedidos/:id/entrega`). Pick up queda listo para pagar, sin costo.
2. La tienda **cotiza** forma de entrega y costo (`POST /pedidos/:id/cotizar`) y lo puede ajustar
   mientras hablan; el comprador puede pedir otra forma (vuelve a cotizarse).
3. Con la entrega definida aparecen el total exacto y el SINPE; el plazo para pagar corre desde la
   cotización. Después de avisar el pago ya no se cambia.
El envío llega completo a la tienda (no paga comisión). Para enviar se exige foto (guía o captura del
viaje de Uber Flash); el pick up no.

## Aprobación de tiendas

Comprar no necesita nada. Para vender: datos de SINPE → **solicitud de tienda** (nombre, Instagram
que solo ve el admin, qué va a vender) → el admin aprueba o rechaza en `/admin → Por hacer` y la
tienda recibe un correo. Mientras espera puede guardar borradores (nunca se publican). "Quitar
aprobación" pausa sus artículos. Se apaga en `/admin → Cobro` ("Aprobar tiendas antes de que
publiquen"). Las tiendas que ya vendían quedaron aprobadas; las que crea el admin, también.

La solicitud pide además: **dirección de la tienda** (privada, solo el admin), **puntos de pick up**
(públicos, uno por línea, hasta 5; el comprador elige uno al pedir pick up; se editan en Mi cuenta),
**fotos de productos** (mínimo 2) y **fotos de envíos hechos** (mínimo 1, o marcar "todavía no he
hecho envíos"). Las fotos son adjuntos privados y cifrados que solo ven la tienda y el admin; al
volver a pedir se reemplazan.

**Pagos a tiendas:** al final del día en que se completa la venta, ya con la comisión rebajada. En
`/admin → Pagos a vendedores` hay un total por tienda para hacer una sola transferencia.

## Chats cifrados

Con `CHAT_KEY` (16+ caracteres) en Railway → Variables, el texto de los mensajes y los archivos
privados (fotos y PDF del chat, capturas del SINPE, guías, evidencia de reclamos) se guardan cifrados
con AES-256-GCM (`src/crypto-box.js`): en la base, en el disco y en los respaldos son ilegibles. Al
arrancar con la clave se cifra también todo lo anterior. No es "punta a punta": el servidor los
descifra para el filtro de contacto, los avisos y los reclamos. **Si `CHAT_KEY` se pierde o cambia,
lo cifrado no se puede leer**: guardarla junto a `BACKUP_PASSWORD`.

## Herramientas del admin

- **Ganancias** (`/admin/ganancias`): comisión de este mes, del anterior y total; gráfico y tabla
  por mes (hora de Costa Rica), por año; tiendas que más comisión dejan; lo que está por entrar
  (pedidos en curso) y lo que se debe a vendedores. "Descargar ventas" baja un CSV que abre en Excel.
  La comisión cuenta cuando la venta se completa.
- **Tiendas destacadas**: en `/admin → Usuarios y tiendas`, "Destacar" por 7, 30, 90 días o sin
  fecha de fin. Sus artículos salen primero en "Más recientes" y en la portada, con la marca
  "★ Destacada". Vence sola.
- **Notificaciones** (`/admin → Notificaciones`): correos al admin (a `ADMIN_EMAIL` o al correo que
  se ponga ahí) cuando un comprador avisa que pagó, hay un reclamo, hay que pagarle a un vendedor o
  reembolsar; opcionales: registros, publicaciones e intentos bloqueados. El botón **Admin** del
  menú muestra cuántas tareas hay pendientes.

## Reseñas, perfiles y bloqueos

- Al completarse un pedido, comprador y vendedor se califican (1–5 estrellas + comentario, que pasa
  por el filtro de contacto). Cada usuario tiene un perfil público en `/u/<id>` con su promedio
  como vendedor y como comprador, sus reseñas y sus artículos.
- Cualquiera puede **bloquear** a otro desde su perfil o el chat: no pueden escribirse ni hacer
  tratos nuevos y no se ven los artículos. Los pedidos ya pagados siguen. Lista en `/bloqueados`.

## ¿Olvidaste tu contraseña?

En `/olvide` la persona pide un enlace (vence en 1 hora, sirve una vez y cierra sus sesiones).
Para que el enlace llegue por correo, configura **Brevo** (plan gratis, sirve con un Gmail):

1. Crea una cuenta en brevo.com → **Remitentes** → agrega y verifica el correo que enviará
   (p. ej. tu Gmail o uno de CowFace).
2. **SMTP y API → Claves API → Generar** una clave nueva.
3. En Railway → Variables: `BREVO_API_KEY` = la clave, `MAIL_FROM` = el correo verificado.

Sin eso, o si un correo no llega: en `/admin → Usuarios → Enlace contraseña` generas el enlace
(vale 24 h) y se lo mandas a la persona, solo al correo de su cuenta.
Con dominio propio también funciona Resend (`RESEND_API_KEY` + `MAIL_FROM`).

## Seguridad

- Contraseñas con scrypt; sesiones aleatorias en cookie `httpOnly`, `secure` y `SameSite=Lax`.
- CSP (solo scripts propios), HSTS, `X-Frame-Options`, bloqueo de formularios desde otros sitios (CSRF).
- Límites: 10 intentos por IP cada 15 min y 10 contraseñas fallidas por cuenta por hora; mensajes,
  ofertas y publicaciones limitados por persona; máximo 3 pedidos sin pagar por comprador.
- Un comprobante de SINPE solo respalda un pedido; los artículos con pedido en curso no se editan.
- Las fotos se validan por su contenido real, no por lo que dice el navegador.
- Nadie puede registrarse con `ADMIN_EMAIL`; cambiar `ADMIN_PASSWORD` cierra las sesiones de admin.
- `npm test` incluye pruebas de todas estas protecciones; `npm audit` sin vulnerabilidades.

## Entrar con Google o Facebook (opcional)

Los botones aparecen solo cuando las variables están en Railway. Pon también
`PUBLIC_URL=https://cowface-production.up.railway.app` (o tu dominio) para que la dirección de
regreso sea exacta. Quien entra por primera vez completa teléfono y provincia en `/completar-perfil`.

**Google** (console.cloud.google.com):
1. Crea un proyecto → **APIs y servicios → Pantalla de consentimiento OAuth**: tipo *Externo*,
   nombre CowFace, tu correo de soporte; al terminar, **Publicar app** (si no, solo entran usuarios de prueba).
2. **Credenciales → Crear credenciales → ID de cliente OAuth → Aplicación web**.
   URI de redireccionamiento autorizado: `<PUBLIC_URL>/auth/google/callback`.
3. Copia el ID y el secreto a las variables `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.

**Facebook** (developers.facebook.com):
1. **Crear app** → caso de uso *Autenticar y solicitar datos con Inicio de sesión con Facebook*.
2. En la configuración de Inicio de sesión con Facebook, **URI de redireccionamiento de OAuth válidos**:
   `<PUBLIC_URL>/auth/facebook/callback`. Pide los permisos `email` y `public_profile`.
3. En **Configuración básica**: URL de política de privacidad `<PUBLIC_URL>/privacidad` y de
   términos `<PUBLIC_URL>/terminos`. Copia el identificador y la clave secreta de la app a
   `FACEBOOK_APP_ID` y `FACEBOOK_APP_SECRET`, y pasa la app a modo **En vivo**.

`/salud?detalle=1` muestra qué está configurado (sin valores privados).

## Dónde está cada cosa

| Qué | Archivo |
|---|---|
| Categorías, tallas, provincias, nombre del sitio | `src/catalog.js` |
| Base de datos (SQLite) | `src/db.js` → `data/cowface.db` |
| Conversaciones y ofertas | `src/chat.js` |
| Pedidos, pagos, reclamos, plazos automáticos | `src/orders.js` |
| Filtro de contacto | `src/moderation.js` |
| Avisos en vivo (Server-Sent Events) | `src/realtime.js`, `public/js/chat.js` |
| Búsqueda e inventario | `src/products.js` |
| Reseñas / bloqueos / Google y Facebook | `src/reviews.js`, `src/blocks.js`, `src/oauth.js` |
| Rutas | `src/routes/` · Vistas: `views/` · Estilos: `public/css/styles.css` |

Las fotos se guardan en `uploads/`. Ni `data/` ni `uploads/` van a git.
