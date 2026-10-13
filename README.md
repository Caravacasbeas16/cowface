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
6. En `/admin → Pagos a vendedores` ves cuánto transferir (precio − 2 %) y a qué SINPE; al hacerlo,
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

## Reseñas, perfiles y bloqueos

- Al completarse un pedido, comprador y vendedor se califican (1–5 estrellas + comentario, que pasa
  por el filtro de contacto). Cada usuario tiene un perfil público en `/u/<id>` con su promedio
  como vendedor y como comprador, sus reseñas y sus artículos.
- Cualquiera puede **bloquear** a otro desde su perfil o el chat: no pueden escribirse ni hacer
  tratos nuevos y no se ven los artículos. Los pedidos ya pagados siguen. Lista en `/bloqueados`.

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
