# FineCapture

Extensión de Chrome (Manifest V3) para capturar páginas o regiones con scroll de forma completa, con preview y exportación a PNG, JPG o WebP.

## Qué hace

1. Detecta la página completa y los contenedores del DOM con scroll.
2. Permite elegir la zona desde el popup o haciendo clic en la página.
3. Hace scroll automático, captura por tramos y une el resultado.
4. Abre un preview para decidir formato (PNG / JPG / WebP) y escala de exportación (10%–100%).
5. Antes de capturar puedes fijar la escala de salida (100% = 1:1).

## Instalación

1. Abre `chrome://extensions`
2. Activa **Modo de desarrollador**
3. Pulsa **Cargar descomprimida**
4. Selecciona esta carpeta: `FineCapture`

## Uso

1. Abre la pestaña que quieras capturar.
2. Pulsa el icono de FineCapture.
3. Elige la zona (lista o «Elegir en la página»).
4. Ajusta la escala 10%–100%.
5. Pulsa **Capturar**.
6. Abre el preview y descarga en el formato deseado.

## Notas

- No captura páginas internas del navegador (`chrome://`, `edge://`, Web Store, etc.).
- Páginas muy altas pueden verse limitadas por el tamaño máximo de canvas del navegador (~16384 px). Usa una escala menor si ocurre.
- Durante la captura se ocultan temporalmente elementos `fixed`/`sticky` para evitar duplicados en cada tramo.
