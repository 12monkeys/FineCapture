# FineCapture (extensión Chrome MV3)
- Stack: JS plano, Manifest V3 (manifest.json v1.2.0): background/, content/, popup/, preview/, lib/, icons/. Sin build ni npm.
- Despliegue: carga descomprimida en chrome://extensions (Modo desarrollador -> Cargar descomprimida -> esta carpeta); tras cambios, pulsar Recargar en la extensión. No hay publicación en Chrome Web Store verificada.
- Git: origin https://github.com/12monkeys/FineCapture.git, rama master. No commit/push sin petición.
- Código a editar: background/, content/, popup/, preview/, manifest.json. No toques lib/ (librerías de terceros) ni icons/ salvo petición.
- Pruebas: manuales en Chrome (no funciona en chrome://, Web Store).