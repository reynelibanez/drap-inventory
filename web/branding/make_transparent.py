"""Quita el fondo blanco del logo ORIGINAL del kit visual y guarda web/branding/drap-logo.png (RGBA, alta resolucion).
Uso:  python3 web/branding/make_transparent.py  <ruta/drap_systems_logo_original.png>
Despues:  python3 web/branding/make_icons.py"""
import os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'drap_systems_logo_original.png')
im = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
H, W, _ = im.shape
mn = im.min(axis=2)

near_white = mn >= 244
lab, _ = ndi.label(near_white)
edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
bg = np.isin(lab, edge[edge > 0])                     # fondo exterior (conectado con los bordes)

# El texto (parte baja) tiene huecos blancos dentro de las letras: tambien son fondo.
split = int(H * 0.66)
text_hole = np.zeros_like(bg); text_hole[split:] = near_white[split:]
bg |= text_hole

# Borde suave: en la franja junto al fondo se calcula la transparencia contra el blanco.
band = ndi.binary_dilation(bg, iterations=3) & ~bg
alpha = np.ones((H, W), np.float32)
alpha[bg] = 0
a_edge = np.clip((255 - mn) / (255 - 70), 0, 1)
alpha[band] = a_edge[band]
a = np.maximum(alpha, 1e-3)[..., None]
fg = np.clip((im - (1 - alpha[..., None]) * 255) / a, 0, 255)
fg[alpha == 0] = 0
out = np.dstack([fg, alpha * 255]).astype(np.uint8)
img = Image.fromarray(out, 'RGBA')
bbox = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
img = img.crop(bbox)
img.save(os.path.join(HERE, 'drap-logo.png'), optimize=True)
print('drap-logo.png', img.size)
