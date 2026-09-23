# DRAP Inventory

Sistema web para el inventario de equipos reacondicionados: **compra por lotes → conteo físico → testeo con grados → ubicación en almacén → venta**.
Multiempresa, en español e inglés, con roles y permisos totalmente configurables.

**Tecnología:** React + Vite (web) · Node.js + Fastify (API) · PostgreSQL · TypeScript.

---

## 1. Instalación en tu PC (Windows)

Requisitos: **PostgreSQL** (ya lo tienes) y **Node.js 20 o superior** (LTS, desde https://nodejs.org).

1. Haz doble clic en **`setup.bat`**. Te pedirá la contraseña del usuario administrador de PostgreSQL (`postgres`) y el **nombre de la base de datos** (Enter = `drap_inventory`; queda guardado en `.env` como `DB_NAME`), instalará todo, creará la base de datos y te pedirá los datos del **primer administrador** y de la primera empresa.
2. Responde **S** si quieres cargar **datos de prueba** para explorar el sistema con un negocio ya en marcha (tarda unos segundos): un lote principal con **≈170 equipos variados** (laptops, desktops, monitores, discos, memorias) testeados por distintos técnicos, otros 4 lotes en cada estado (registrado, en conteo, contado y cerrado), 10 clientes, 5 proveedores, 3 vendedores, costos y reglas de precio, ubicaciones en 2 almacenes, **14 pedidos** (abiertos, completados, cancelados, con faltantes y descuentos), 5 ventas rápidas y 23 activos de la empresa. También crea 6 usuarios de prueba (`vendedor1`, `vendedor2`, `tecnico1`, `tecnico2`, `almacen1`, `consulta1`; contraseña inicial `Demo2026!`) para probar los permisos y "solo mis ventas". **Responde N si vas a usar el sistema de verdad**; también puedes cargarlos después con `npm run db:seed-demo` (o `--force` si la empresa ya tiene lotes) y borrar los usuarios de prueba desde Equipo → Usuarios.
3. Para usarlo, haz doble clic en **`start.bat`** (abre http://localhost:3000). Para que otras PCs de la oficina entren, usa `http://IP-DE-TU-PC:3000` (abre el puerto 3000 en el firewall de Windows).

Otros archivos: **`update.bat`** (tras recibir una nueva versión) y `npm run backup` (copia de seguridad, ver §5).

### Desarrollo

```
npm run dev        # API en :3000 y web en :5173 con recarga automática
npm test           # 72 pruebas de integración (crean su propia base "refurbiz_test")
npm run i18n:check -w web   # verifica que no falten traducciones es/en
```

---

## 2. Cómo funciona el flujo

| Paso | Dónde | Qué pasa |
|---|---|---|
| **Compra** | Lotes → Nuevo lote | Cada lote tiene un código (`L260901`: año, mes, consecutivo) y líneas por tipo de equipo con sus datos (marca, modelo, procesador, RAM…) y cantidad esperada. |
| **Conteo** | Detalle del lote | Se escribe la cantidad contada por línea. Se muestran faltantes/sobrantes y se pueden agregar **ítems inesperados** que no estaban en el lote. Al terminar el conteo, si quedan líneas sin contar, pide confirmación. |
| **Testeo** | Testeo | El técnico registra cada equipo (escaneando el serial). Se genera el código **`L260901-1t120`** = lote + técnico + registro **único por técnico**. Se completan todos los datos y los **grados cosmético y funcional**. Al terminar queda **Disponible** (o **No vendible** si el grado lo indica). |
| **Ubicación** | **Automática al terminar el testeo** / Ubicaciones | El equipo recibe su ubicación solo, según las **reglas de cada nivel del rack** (tipo de equipo, grados y agrupación, ver §3). Si ningún nivel lo admite, cae en la sugerencia inteligente (mismo modelo → marca → tipo). Puedes cambiarla cuando quieras. |
| **Venta** | Pedidos | El pedido se arma por **líneas por tipo** (ej. *Laptop · Dell · grado A o B · 20 unidades*), sin códigos. Después se agregan **por código** los equipos que se escogieron del rack, **una a una** (escaneando: cada código + Enter se agrega al instante) o **por lote** (pegando la lista; en Inventario, el botón *Copiar códigos* copia los equipos seleccionados): el sistema los compara con las líneas y **avisa** si alguno no coincide, pero siempre deja agregarlo. En la pestaña *Ubicaciones* del pedido sale el **listado de dónde está cada equipo** para ir a buscarlos. También hay **Agregar por cantidad** (equipos disponibles agrupados por tipo y características: escribes cuántos quieres de cada grupo, sin escoger códigos; se toman los más antiguos) y *Buscar y reservar*. **Un pedido sin líneas no admite equipos**: primero se define qué se vende. Al **completar** pasan a *Vendido*; al cancelar vuelven a *Disponible*. Packing list en Excel, CSV o PDF. |
| **Venta rápida** | Pedidos → *Venta rápida* (o Inventario → seleccionar → *Venta rápida*) | Vende equipos **sin crear un pedido** y sin datos del cliente: escaneas, escribes o pegas los códigos y vendes. Cliente, precio y notas son opcionales. Queda registrada como una venta completada (con la etiqueta *Venta rápida*) para el historial y los reportes. |
| **Activos de la empresa** | Operación → *Activos* | Herramientas y equipos que son **de la empresa** (no se venden). Se registran con los **mismos tipos de equipo y atributos** que ya tienes, pero como *inventario de la empresa* en lugar de *testeado*: sin lote, sin testeo, sin ubicación de almacén y sin pedidos. Cada activo tiene código propio (formato en *Empresa y ajustes*, por defecto `A-0001`), nombre opcional, serie, **responsable**, **lugar**, fecha de adquisición, notas y un estado (*En uso, Guardado, En reparación, Dado de baja*; el catálogo es editable). Con **Cantidad** se registran varios iguales de una vez (5 destornilladores = 5 códigos). Se pueden imprimir etiquetas (mismas plantillas por tipo), escanear su código en el buscador de arriba y ver su historial. Permisos: *Ver activos* y *Registrar, editar y dar de baja activos*. |

Cada equipo tiene **historial completo** (quién, cuándo, qué). Hay etiquetas con código QR para imprimir (de equipos y de pedidos) y un buscador global (arriba) que acepta código, serial o lote. Un equipo testeado se puede **editar o eliminar mientras no esté vendido** (si estaba reservado, sale del pedido); uno vendido queda bloqueado. En la pantalla **Testeo**, cada equipo del lote tiene botón **Editar** (en testeo abre el formulario para terminarlo; ya testeado, para corregir sus datos) y **Eliminar**, que en equipos ya testeados solo aparece si están **Disponibles** (los borradores en testeo también se pueden descartar).

## 3. Todo es configurable (nada atado al código)

- **Catálogos** (Configuración → Catálogos): grados cosméticos y funcionales (A, B, C…), marcas, procesadores, capacidades, tipos de cliente, etc. Puedes agregar, renombrar (en es/en), reordenar, colorear o desactivar valores. Un grado funcional puede marcarse "no vendible".
- **Modelos por tipo de equipo** (catálogos *Modelos de Laptop*, *… de Computadora de escritorio*, *… de Monitor*, *… de Disco duro*, *… de Memoria RAM* y *… de Genérico*): cada tipo tiene su propio catálogo de modelos, que **depende del catálogo de Marcas** (cada modelo pertenece a su marca). Vienen cargados con **los 10 modelos más comunes en el mercado de reacondicionados de EE. UU. por marca** (ordenados de más a menos popular; es una lista de partida hecha con datos del mercado, no de tus ventas: edítala, reordénala o amplíala). En el catálogo puedes **filtrar por marca**. Al llenar el campo *Modelo* de un lote o equipo, se **sugieren los modelos de la marca elegida** (y se puede escribir otro distinto). Cada tipo nuevo que crees recibe su catálogo de modelos vacío. Cualquier catálogo puede depender de otro (*Depende de otro catálogo* al crearlo) y cualquier campo de texto de un tipo puede tener su lista de sugerencias (Tipos de equipo → atributo → *Sugerir*).
- **Tipos de equipo** (Configuración → Tipos de equipo): laptops, escritorio, monitores, discos, memorias y **Genérico**; crea los tuyos y decide qué datos lleva cada uno, cuáles aparecen en el lote y cuáles son obligatorios al testear.
- **Empresa y ajustes**: formato de códigos, días de reserva, pesos de la ubicación inteligente.
- **Ubicaciones**: almacenes → áreas → racks → niveles → espacios, con capacidad por espacio; cada nivel puede tener distinta cantidad de espacios.
- **Reglas por nivel del rack** (Ubicaciones → rack → Editar → botón *Regla* de cada nivel), configurables al crear o editar el rack: **tipo de equipo** que va en ese nivel, **grados cosméticos y funcionales** permitidos, y **agrupar por las propiedades del tipo** (marca, modelo, RAM, disco…) **en el orden que elijas**; con "un espacio = un solo grupo" no se mezclan grupos. Hay botón para copiar la regla a todos los niveles.

### Etiquetas (DYMO u otra impresora)

- **Diseño** (Configuración → Etiquetas): elige el tamaño (DYMO 30334, 30336, 30252, 30321…, o medidas propias en mm), arrastra los datos del equipo sobre la etiqueta y cambia letra, alineación y tamaño. Los datos disponibles salen de **los atributos del tipo de equipo** (marca, modelo, RAM…) más lo fijo (código, serie, lote, grados, fecha, técnico…). Puedes insertar **código QR** y **código de barras** (Code 128), líneas y recuadros, y ver la vista previa con datos de ejemplo o con un equipo real.
- **Asociación**: marca los tipos de equipo que usan cada plantilla; los tipos sin plantilla usan la *predeterminada*. Al **terminar el testeo** se abre la impresión con la etiqueta de ese tipo (se puede desactivar con la casilla de la pantalla Testeo).
- **Imprimir**: también desde Inventario, Lote y el detalle de un equipo (varios equipos a la vez, con copias). Se abre el diálogo de impresión del navegador: elige la impresora DYMO y el papel del mismo tamaño que la etiqueta (o "Guardar como PDF"). Para imprimir sin diálogo, abre Chrome con `--kiosk-printing`. Si tu impresora entrega la etiqueta de lado, usa la rotación 90° de la plantilla.
- **Etiquetas de documentos (envío del pedido)**: en Configuración → Etiquetas hay dos clases de plantilla: *de equipo* (asociadas a tipos) y *de documento* (**Nueva etiqueta de documento**). La de pedido usa los mismos elementos y el mismo diseñador, con datos del pedido: **cliente** (nombre, dirección, teléfono), código del pedido, **bulto 1/3**, **peso**, **medidas** (largo × ancho × alto), cantidad de equipos, resumen por tipo, fecha, vendedor, notas, QR y código de barras del pedido. Viene una etiqueta de envío 4 × 6 in (102 × 152 mm) ya hecha; puedes tener varias y elegir una como predeterminada.
- **Imprimir desde el pedido**: botón *Etiquetas de envío* en el detalle del pedido. Indicas cuántos **bultos** hay y el peso y las medidas de cada uno (lb/kg, in/cm); sale **una etiqueta por bulto**. Los datos de envío se guardan en el pedido, así que puedes reimprimir (incluso con el pedido ya completado).
- Al iniciar, el sistema aplica solo las actualizaciones de base de datos pendientes (basta reiniciar `start.bat`).

### Grids (tablas)

Todas las tablas del sistema tienen: **arrastrar columnas para cambiar el orden**, redimensionarlas, elegir qué columnas ver (en Inventario cada propiedad del tipo de equipo es una columna opcional), ordenar y **filtrar directamente en la columna**. Los filtros cambian según el tipo de dato (texto: contiene/empieza/igual…; número y dinero: mayor/menor/entre; fecha: hoy, últimos N días, este mes, entre; lista: varios valores; sí/no). El orden y las columnas quedan guardados por usuario en el navegador.

**Exportar** (Excel, CSV o PDF) está en todas las tablas: exporta **exactamente lo que se ve** — con filtros aplicados sale lo filtrado; sin filtros, todo.

### Apariencia y temas

Menú lateral → icono de paleta (*Apariencia*). El sistema usa la identidad visual de **DRAP Systems** (Deep Navy #0A2F4A, Tech Blue #1277B0, Cyan #2AB6E6, tipografías Montserrat e Inter) y tiene **solo dos temas**: **DRAP Claro** y **DRAP Noche**, más el modo **Automático** (usa uno u otro según tu equipo). El botón de temas del menú (automático / sol / luna) cambia entre ellos; además puedes elegir densidad cómoda o compacta. La barra lateral es siempre azul noche. Es una preferencia personal de cada usuario (se guarda en el navegador). La pantalla de acceso (login) usa el escudo de DRAP sobre fondo azul con patrón de circuito, tarjeta de cristal, «Recordar usuario», mostrar/ocultar contraseña e idioma ES/EN; el logo se genera del original del kit con `web/branding/make_transparent.py` y `make_icons.py`.

### Inventario: solo disponible y panel de grupos

*Inventario* abre por defecto mostrando **solo lo disponible** (se quita con la «x» de la etiqueta *Solo disponibles* o eligiendo otros estados). A la izquierda está el panel **Agrupar inventario**: chips de **estado** con su conteo (puedes marcar varios) y un **árbol de grupos** con conteos y barras. **Tú escoges por dónde agrupar** (botón de ajustes del panel): hasta 3 niveles, por ejemplo *Tipo → Marca → Grado*, con cualquier columna de lista del inventario (tipo, grados, ubicación, lote, técnico y las propiedades del tipo de equipo), ordenados por nombre o por cantidad. Al hacer clic en un grupo, **el listado se filtra** por ese grupo (y otro clic lo quita). Tu elección se recuerda en el navegador. En el teléfono el panel se pliega arriba de la lista.

### Panel

Las tarjetas y **gráficas del panel dependen de lo que el usuario puede ver**: inventario por estado/tipo/grado y antigüedad, testeo por día y por técnico, ocupación de almacenes, lotes, ventas (con dinero solo si tiene permiso de ver precios) y actividad reciente (solo con permiso de historial). Un técnico ve su propia actividad; un vendedor, sus cifras.

### Aplicación instalable (PWA) y notificaciones push

- **Instalar como app**: en Chrome/Edge (PC y Android) aparece el botón *Instalar app* (barra superior y *Notificaciones → Ajustes*); la app se abre en su propia ventana, con icono propio. En iPhone/iPad: Compartir → *Añadir a pantalla de inicio*. La pantalla se actualiza sola: cuando hay una versión nueva sale el aviso *Actualizar*. Sin internet abre la pantalla guardada y sigue funcionando en **modo sin conexión** (ver la sección siguiente).
- **Campana** (barra superior): avisos dentro del sistema, con contador de no leídos. *Notificaciones* muestra la bandeja completa y los **Ajustes**: activar los avisos en ese dispositivo, ver/quitar tus dispositivos y elegir, aviso por aviso, si lo quieres en la bandeja y/o como notificación push.
- **Avisos** (solo llegan los que corresponden a tus permisos y nunca los de tus propias acciones): conteo de lote terminado, lote listo para testear, pedido nuevo, venta completada, pedido cancelado, **reserva por vencer (24 h antes)** y reserva vencida.
- **Requisitos**: las notificaciones push necesitan **HTTPS** (o `localhost` en la propia PC), es decir, funcionan a plena capacidad en el VPS con dominio. En iPhone/iPad solo funcionan con la app **ya instalada en la pantalla de inicio**. Las claves de envío (VAPID) se generan solas; si quieres, en `.env` pon `VAPID_SUBJECT=mailto:tu-correo` (ver `.env.example`). No requiere instalar nada nuevo.

### Modo móvil (teléfono)

En pantallas de hasta 820 px de ancho (teléfonos) el sistema cambia a un **diseño propio para móvil**, no solo una versión reducida: **barra inferior** (Panel, Lotes, Testeo, Inventario y *Más*), menú *Más* con el resto de las secciones, ajustes, idioma y tema, botón de **escáner/búsqueda** arriba, y las ventanas se abren como **hojas que suben desde abajo** (se cierran arrastrando hacia abajo). Las tablas se muestran como **tarjetas** (búsqueda, filtros, orden, columnas y exportar en una hoja de *Filtros*), los conteos usan **botones − / +**, los grados se escogen con **botones tocables** y los formularios largos tienen la barra de acciones fija abajo. Listas con detalle (Ubicaciones, Catálogos) van en dos pasos con botón *volver*. La lógica es la misma que en PC; solo cambia la presentación. El **diseñador de etiquetas** es mejor en pantalla grande (en el teléfono avisa).

### Modo sin conexión

Se guarda una copia de trabajo en la **base de datos del navegador (IndexedDB)** de cada dispositivo, para seguir trabajando sin internet:

- **Qué se puede hacer sin conexión**: crear lotes (con líneas), contar, agregar líneas o ítems inesperados, cambiar el estado del lote, eliminar un lote sin datos, y **registrar, editar, terminar y eliminar equipos en Testeo**. Además se pueden **consultar** las pantallas ya visitadas (Inventario, Lotes, Panel…). Lo demás (pedidos, ventas, ajustes, usuarios…) necesita internet y lo avisa.
- **Sincronización**: cada cambio queda en una **cola** en el dispositivo (menú *Más* → *Sincronización* muestra lo pendiente, lo que espera y los errores). Al volver internet se envía **solo, en el mismo orden en que se hizo**; también hay botón *Sincronizar ahora*. Mientras tanto, lo pendiente se ve marcado en las listas y los códigos provisionales (`PEND-1`) se reemplazan por los reales al sincronizar.
- **Sin perder ni duplicar datos**: cada envío lleva una **clave de idempotencia** (migración `015`): si se corta la conexión a mitad, al reintentar el servidor reconoce el envío y no lo repite. Si un cambio ya no es válido (p. ej. otro usuario lo modificó o vendió el equipo), **no se descarta**: queda en *Con error* con el motivo para revisarlo. Sin conexión no se puede entrar por primera vez ni cambiar de usuario; sí se continúa con la sesión ya iniciada. Al cerrar sesión se borra la copia local.
- **Modelos nuevos**: si escribes un modelo que no existe (en un lote o al registrar un equipo), **se guarda en el catálogo de modelos** del tipo y la marca para usarlo después. En el servidor se hace en la misma transacción del lote/equipo; sin conexión, el modelo queda disponible **de inmediato en ese dispositivo** y pasa al catálogo al sincronizar.

### Eliminar un lote sin datos

Un lote se puede **eliminar mientras no tenga datos**: sin equipos registrados y sin conteos guardados (las líneas sí se eliminan con él). En la lista de Lotes (icono de papelera) y en el detalle (*Datos del lote* → *Eliminar lote*) el botón solo aparece si es posible; si algo cambió, el servidor lo rechaza con el motivo. Funciona también sin conexión (si el lote aún no se había sincronizado, simplemente desaparece de la cola).

### Costos y precios

**Costos de un lote** (pestaña *Costos* del lote, o al crearlo). Se separan tres cosas: el **costo de la mercancía** (lo que se pagó al proveedor), los **costos adicionales** (flete, seguro, aranceles…; cada uno marcado *Repartir entre los equipos* o no) y **cómo se reparte** entre los equipos. El reparto se define con una **lista ordenada de reglas**: cada grupo de equipos queda en la primera regla que le corresponde, y cada regla dice *a quién aplica* (tipo de equipo, línea del lote, propiedades como marca/RAM, grado cosmético o funcional, o equipos sin línea) y *cómo se reparte*:

- **Monto fijo por equipo** · **Monto total del grupo** (parejo entre sus equipos) · **Porcentaje del total** · **Peso relativo** (un equipo con peso 2 recibe el doble que uno con peso 1) · **Proporcional al precio de lista** · **Proporcional al costo**.
- Lo que ninguna regla reclama se reparte por igual, o proporcional al precio de lista / al costo (*base*). Lo que queda después de los montos fijos se reparte por peso.
- Se ve el resultado antes de guardar (vista previa con avisos: “lo fijado supera el monto”, “sobra monto”, regla sin uso…). *Guardar y repartir* escribe el costo en cada equipo.
- **Costo individual**: en el equipo (o en bloque desde Inventario → *Costo*) se fija un costo exacto, se sube/baja un porcentaje o un monto, o se vuelve al reparto del lote. Un costo fijado a mano **se respeta**; el resto del lote se reparte de nuevo sin él (igual que los equipos ya vendidos, que no cambian).
- **Recalcular automáticamente** (activado por defecto): al cambiar conteos, costos o equipos del lote, el reparto se actualiza solo; si lo desactivas, el lote muestra *Desactualizado* hasta que vuelvas a repartir. Los equipos que entran después heredan el costo de su línea.
- **Planes guardados**: guarda un juego de reglas con un nombre y reutilízalo en otros lotes.

**Precios de lista** (menú *Ventas → Precios*, columna *Precio* del inventario y ficha del equipo). Reglas ordenadas por tipo, propiedades, grados, lote o rango de costo: **precio fijo**, **costo + %** (recargo), **margen % sobre el precio**, **costo + monto**, con **redondeo** (a 1, 5, 10 o terminado en .99) y precio mínimo. Se calculan solas al terminar el testeo o cuando cambia el costo (se puede desactivar) y se pueden **recalcular** con vista previa de lo que cambiaría. Un precio fijado a mano por equipo (o en bloque: exacto, ±%, ±monto, margen sobre el costo) **no lo tocan las reglas**, salvo que pidas reemplazarlo.

**Precio de un pedido** (pestaña *Precios* del pedido). El precio de cada equipo sale de su precio de lista (o se escribe uno). Además: **descuentos y cargos** (porcentaje o monto: descuento, envío, impuesto) que dan el *total*; **ganancia** y margen (costo de los equipos vs. venta; los cargos no cuentan como ganancia y los descuentos sí se restan); y **repartir un precio total entre los equipos**: escribes cuánto paga el cliente (subtotal o total final) y las mismas reglas de reparto de arriba deciden el precio de cada renglón — los renglones suman **exactamente** el monto.

**Permisos**: *Ver costos y márgenes* (`costs.view`), *Repartir y editar costos* (`costs.manage`) y *Administrar precios de lista y reglas* (`prices.manage`). Sin *Ver costos* no se muestra ningún costo ni margen (tampoco en reportes, packing list o PDF). Ver y fijar el precio de venta sigue siendo *Ver y fijar precios*. Al actualizar, los roles que ya podían administrar usuarios reciben los tres permisos; **quien antes escribía el costo total del lote necesita ahora *Repartir y editar costos***. Los costos y precios requieren conexión (no están disponibles en el modo sin conexión).

### Reportes

Menú *Reportes*. Incluye **13 reportes del sistema** (inventario, stock por tipo y grado, por modelo, por ubicación, equipos sin ubicar, testeo por técnico, lotes, pedidos abiertos, equipos vendidos, ventas por cliente…) y un **diseñador de reportes personalizados**:

- Elige la **fuente** (equipos, lotes, líneas de lote, pedidos, líneas de pedido, ubicaciones), las **columnas** (incluye todas las propiedades del tipo de equipo), el orden, **filtros** según el tipo de dato, y si es **detalle** o **resumen** (agrupar y contar/sumar/promediar). Vista previa en vivo.
- **Privado**: solo lo ve quien lo creó (ni siquiera un administrador). **Compartido con la empresa**: requiere el permiso *Compartir reportes*.
- **Respeta los permisos**: solo se pueden usar datos que el usuario ve (por ejemplo, sin *Ver precios* no puede usar columnas de precio). Si a alguien se le quita un permiso, ese dato desaparece de los reportes que ya use.
- Los reportes del sistema no se modifican, pero se pueden **duplicar** y personalizar. Todo reporte se exporta a Excel, CSV y PDF.

También se exportan: **packing list** del pedido (detallado por equipo o resumido por tipo, sin precios), **reporte del lote** y **equipos del lote**.

### Usuarios, roles y permisos

- El **administrador principal** es el que se crea en la instalación: es **único**, no se puede modificar ni eliminar desde Usuarios, y es el **único que puede crear más empresas**.

- Un usuario **no está atado a un rol**: puede tener varios roles y además excepciones **individuales** (permitir o denegar funciones concretas). Ejemplo: dos usuarios con rol *Ventas* donde solo uno puede cancelar pedidos.
- Los permisos son por **función del sistema** (ver lotes, crear lotes, testear, reservar, cancelar ventas, ver precios…). Puedes crear roles propios marcando funciones.
- Roles iniciales de ejemplo: Administrador, Almacén, Técnico, Ventas, Solo consulta (se pueden editar).
- **Ventas propias o de todos (función «Ver las ventas de TODOS los vendedores»)**: cuando un usuario **no** la tiene, solo ve **sus** ventas: los pedidos que creó o donde él es el vendedor (en listados, panel, reportes, avisos, packing list y en el detalle de cada equipo; los pedidos ajenos aparecen como inexistentes). Es **opcional y se puede poner o quitar**: en *Roles* con dos botones («Solo sus propias ventas» / «Las ventas de todos»), y por usuario en *Usuarios → Permisos individuales* («Según su rol» / «Solo sus ventas» / «Las de todos»). De fábrica, el rol *Ventas* ve solo lo suyo; Administrador y Solo consulta ven todo; los roles que ya existían siguen viendo todo hasta que los cambies.

### Multiempresa e idiomas

- Cada empresa tiene sus propios catálogos, usuarios, lotes, inventario y ventas, **aislados a nivel de base de datos** (Row Level Security). Un usuario puede pertenecer a varias empresas y cambia desde el menú lateral.
- Las nuevas empresas las crea solo el administrador principal (menú *Plataforma*).
- Interfaz en **español e inglés** (botón ES/EN). Los nombres de catálogos y tipos se guardan en ambos idiomas.

---

## 4. Seguridad

- Contraseñas con scrypt; sesión con token de acceso corto + cookie de renovación `httpOnly`; límite de intentos de acceso.
- La aplicación se conecta con un usuario de PostgreSQL **sin privilegios de administrador** (`<nombre_de_la_base>_app`, por ejemplo `drap_inventory_app`), condición necesaria para que el aislamiento por empresa funcione. El administrador de PostgreSQL solo se usa en `db:setup` y `db:migrate`.
- Todas las acciones importantes quedan en el **Historial** (Configuración → Historial).
- El archivo `.env` contiene claves: no lo compartas ni lo subas a ningún repositorio.

## 5. Copias de seguridad y migración al VPS

### Poner en producción en otra PC o servidor

Hay dos formas; usa la que prefieras:

- **Copiar la carpeta completa** del proyecto (sin `node_modules`, `.env` ni `backups`), ejecutar `setup.bat`, configurar y luego `start.bat`. Sirve, pero deja allí todo el código fuente.
- **Paquete de producción (recomendado si solo quieres *correr* el sistema)**: en tu PC de desarrollo ejecuta **`empaquetar.bat`** (o `npm run release`). Crea la carpeta `release/` con `drap-inventory-1.0.0.zip`: solo la aplicación ya compilada (sin código fuente ni herramientas de desarrollo). Con la opción 2 (`--with-modules`) incluye también las dependencias, así la otra máquina **no necesita internet**. Con la opción 3 (`--with-node`, solo Windows) incluye además un **Node.js portátil** (`runtime\node.exe`, copiado del Node que tienes instalado en esa PC): la otra máquina **solo necesita PostgreSQL** y el zip pesa unos 30–50 MB. En la máquina destino hacen falta **Node.js 20+** (salvo con la opción 3) y **PostgreSQL** (puede estar en otra máquina):
  1. Descomprime el zip.
  2. `instalar.bat` (Windows) o `bash instalar.sh` (Linux): pide los datos de PostgreSQL y el nombre de la base de datos (Enter = `drap_inventory`), crea la base, el administrador y la empresa.
  3. `iniciar.bat` / `bash iniciar.sh` (o como servicio: `ejemplos/refurbiz.service`).
  - **Todo incluido (opción 4 de `empaquetar.bat`, `--with-node --with-postgres`, solo Windows)**: además de Node.js, copia dentro del paquete el **PostgreSQL instalado en tu PC** (`runtime\pgsql`, unos 150–300 MB): la otra máquina **no necesita instalar nada** (a lo sumo el «Microsoft Visual C++ Redistributable x64» si Windows lo pide). `instalar.bat` crea sola la base de datos local (`data\pg`, puerto 5433, solo accesible desde esa máquina; solo te pregunta el **nombre de la base**, Enter = `drap_inventory`, o puedes fijarlo sin preguntas con la variable `DRAP_DB_NAME`), genera el `.env` con claves aleatorias, y `iniciar.bat` la enciende y apaga junto con el sistema (`detener.bat` la apaga si quedó encendida). `respaldar.bat`/`restaurar.bat` usan las herramientas del propio paquete. **No borres la carpeta `data`**: ahí están los datos. Si tu PC tiene PostgreSQL en otra ruta: `npm run release -- --with-node --with-postgres --pg-dir="C:\ruta\PostgreSQL\16"`.
  - **Actualizar**: genera un paquete nuevo, copia su contenido encima (el `.env` y la base de datos se conservan) y ejecuta `actualizar.bat`.
  - **Copias de seguridad en Windows**: `respaldar.bat` (crea el `.dump` en `backups`) y, para restaurar, arrastra el `.dump` sobre `restaurar.bat`. También sirven `npm run backup` / `npm run restore -- archivo.dump` donde haya Node instalado.
  - El paquete trae su propio `LEEME-PRODUCCION.md` con estos pasos.
- **Docker** (abajo): también funciona sin llevar el código fuente si construyes la imagen una vez y la subes a un registro.

Recuerda: la instalación como app, las notificaciones y el modo sin conexión del teléfono requieren **HTTPS** (o `localhost`); en un servidor pon un proxy con certificado (ver `deploy/Caddyfile`) y `COOKIE_SECURE=true`.

**Copia de seguridad** (haz una a diario; programa `npm run backup` con el Programador de tareas de Windows):

```
npm run backup          # crea backups/refurbiz-AAAAMMDD-HHMM.dump
```

**Migrar de la PC a un VPS** (todo en el VPS: app + base de datos)

Opción A — Docker (recomendada):

1. En el VPS instala Docker y copia esta carpeta (sin `node_modules`).
2. `cp deploy/docker.env.example .env` y completa claves y dominio.
3. `docker compose --profile https up -d --build` (HTTPS automático con Caddy; apunta el DNS del dominio al VPS). Sin dominio: `docker compose up -d --build` y entra por `http://IP:3000` con `COOKIE_SECURE=false`.
4. Crea el administrador: `docker compose exec app node server/dist/cli/create-admin.js`.
5. Para llevar tus datos actuales: copia el `.dump` al VPS y ejecuta
   `docker compose exec -T db pg_restore -U postgres -d refurbiz --clean --if-exists --no-owner --no-privileges < backups/archivo.dump`
   y después `docker compose restart app` (aplica migraciones y permisos al arrancar).

Opción B — sin Docker: instala Node 20+ y PostgreSQL en el VPS, copia la carpeta, ejecuta `node scripts/setup-env.mjs`, `npm install`, `npm run build`, `npm run restore -- archivo.dump`, y deja `npm start` corriendo con **pm2** o **systemd** detrás de nginx/Caddy con HTTPS (poniendo `COOKIE_SECURE=true`).

## 6. Estructura del proyecto

```
server/            API (Fastify) — src/modules/* (una por área), src/services/* (ubicación inteligente, códigos…)
  migrations/      SQL versionado (001…016); se aplican con npm run db:migrate
  test/            pruebas de integración
web/               React — src/pages/*, src/components/* (mobile/ = diseño móvil), src/lib/offline/* (base local, cola y sincronización), src/styles/mobile.css, src/i18n/{es,en}/*.json
scripts/           setup-env, backup, restore
```

Comandos útiles: `npm run db:setup` · `npm run db:migrate` · `npm run create-admin` · `npm run db:seed-demo` · `npm run build` · `npm start`.

Para agregar una función nueva con permiso propio: declara el permiso en `server/src/permissions.ts`, protégelo en la ruta con `route('modulo.accion', …)` y añade su texto en `web/src/i18n/{es,en}/team.json`; aparecerá sola en la pantalla de roles.

## 7. Ideas para una siguiente etapa

Listas de precio por cliente · ganancia en el panel · reparaciones y piezas · fotos por equipo · programar el envío de reportes por correo · importación de líneas de lote desde Excel · impresión directa de etiquetas · notificaciones por correo.
