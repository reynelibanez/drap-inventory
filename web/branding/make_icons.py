"""Genera los iconos de la app a partir del logo (web/branding/drap-logo.png).
Uso (solo si cambias el logo):  python3 web/branding/make_icons.py
El logo (drap-logo.png) se obtiene del original del kit con make_transparent.py."""
import base64, io, os
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
os.makedirs(os.path.join(PUB, 'icons'), exist_ok=True)

logo = Image.open(os.path.join(HERE, 'drap-logo.png')).convert('RGBA')
W, H = logo.size
SHIELD_BOTTOM = round(H * 0.71)          # el escudo ocupa la parte de arriba; debajo va el texto "DRAP Systems"

def up(im, scale):
    """Amplia con buena calidad y afina un poco para que no se vea borroso."""
    out = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    return out.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))

def fit(im, box_w, box_h):
    s = min(box_w / im.width, box_h / im.height)
    return im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)

def tile(size, im, fill, bg=(255, 255, 255, 255)):
    """Cuadrado `size` con `im` centrado ocupando `fill` (0-1) del alto/ancho."""
    canvas = Image.new('RGBA', (size, size), bg)
    # se amplia primero (mas nitido) y luego se reduce al tamano final
    big = up(im, max(1, (size * fill) / max(im.width, im.height)) if size * fill > max(im.width, im.height) else 1)
    f = fit(big, size * fill, size * fill)
    canvas.alpha_composite(f, ((size - f.width) // 2, (size - f.height) // 2))
    return canvas

shield = logo.crop((0, 0, W, SHIELD_BOTTOM))
bbox = shield.getchannel('A').point(lambda v: 255 if v > 30 else 0).getbbox()
shield = shield.crop(bbox)

# --- logos para la interfaz (barra lateral, inicio de sesion)
def to_height(im, h):
    return im.resize((round(im.width * h / im.height), h), Image.LANCZOS) if im.height > h else im
to_height(shield, 480).save(os.path.join(PUB, 'logo-shield.png'), optimize=True)   # nitido incluso en pantallas 2x/3x
to_height(logo, 640).save(os.path.join(PUB, 'logo-full.png'), optimize=True)

# --- pestana del navegador: solo el escudo (legible a 16-32 px), fondo transparente
fav = tile(64, shield, 0.96, bg=(0, 0, 0, 0))
fav.save(os.path.join(PUB, 'favicon.png'), optimize=True)
ico = [tile(s, shield, 0.96, bg=(0, 0, 0, 0)) for s in (48, 32, 16)]
ico[0].save(os.path.join(PUB, 'favicon.ico'), format='ICO', sizes=[(48, 48), (32, 32), (16, 16)], append_images=ico[1:])

# --- app instalada: logo completo sobre blanco
tile(192, logo, 0.90).convert('RGB').save(os.path.join(PUB, 'icons', 'icon-192.png'), optimize=True)
tile(512, logo, 0.90).convert('RGB').save(os.path.join(PUB, 'icons', 'icon-512.png'), optimize=True)
tile(512, logo, 0.62).convert('RGB').save(os.path.join(PUB, 'icons', 'maskable-512.png'), optimize=True)   # zona segura de iconos "maskable"
tile(180, logo, 0.86).convert('RGB').save(os.path.join(PUB, 'icons', 'apple-touch-icon.png'), optimize=True)

# --- insignia de notificaciones: silueta blanca del escudo sobre transparente
sil = tile(96, shield, 0.86, bg=(0, 0, 0, 0))
badge = Image.new('RGBA', sil.size, (255, 255, 255, 0))
badge.putalpha(sil.getchannel('A'))
badge_px = badge.load()
for y in range(badge.height):
    for x in range(badge.width):
        a = badge_px[x, y][3]
        badge_px[x, y] = (255, 255, 255, a)
badge.save(os.path.join(PUB, 'icons', 'badge-96.png'), optimize=True)

# --- versión mini en base64 para la pantalla "sin conexión" del service worker
mini = fit(shield, 64, 64)
buf = io.BytesIO(); mini.save(buf, format='PNG', optimize=True)
print('SW_LOGO_DATA_URI=data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode())
print('shield', shield.size, 'logo', logo.size)
