# FineCapture

Extensión de Chrome (Manifest V3) para capturar páginas o regiones con scroll de forma completa, con preview y exportación a PNG, JPG o WebP.

## Qué hace

1. Detecta la página completa y los contenedores del DOM con scroll.
2. Permite elegir la zona desde el popup o haciendo clic en la página.
3. Modo **Imagen**: scroll automático, captura por tramos y une el resultado.
4. Modo **Solo texto**: extrae el texto visible del DOM de esa zona (ideal para chats), conservando títulos y bloques; opción de orden cronológico (antiguo → reciente); exporta TXT o Markdown.
5. Abre un preview para descargar imagen (PNG / JPG / WebP) o texto (TXT / MD).
6. En modo imagen puedes fijar la escala de salida (100% = 1:1) y ocultar overlays flotantes.

## Instalación

1. Abre `chrome://extensions`
2. Activa **Modo de desarrollador**
3. Pulsa **Cargar descomprimida**
4. Selecciona esta carpeta: `FineCapture`

## Uso

1. Abre la pestaña que quieras capturar.
2. Pulsa el icono de FineCapture.
3. Elige la zona (lista o «Elegir en la página»).
4. Elige modo **Imagen** o **Solo texto**.
5. En imagen, ajusta la escala 10%–100% y la limpieza de overlays.
6. Pulsa **Capturar** / **Extraer texto**.
7. En el preview, descarga en el formato deseado.

## Notas

- No captura páginas internas del navegador (`chrome://`, `edge://`, Web Store, etc.).
- Páginas muy altas pueden verse limitadas por el tamaño máximo de canvas del navegador (~16384 px). Usa una escala menor si ocurre.
- Opción **Ocultar overlays flotantes** (activada por defecto): esconde `fixed`/`sticky` y también `absolute` anclados al borde (p. ej. barras inferiores tipo `Pos(a) B(0)`), detectando además elementos que no se mueven al hacer scroll.
- Opción **Expandir sliders / carruseles**: detecta carruseles (Keen Slider / Tinder, Swiper, Slick, etc.), avanza slide a slide (API o toque izq/der), espera fotos lazy, los apila en vertical y sustituye esa zona en la captura completa.
