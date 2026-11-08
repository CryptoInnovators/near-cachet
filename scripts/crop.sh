#!/bin/bash
# crop.sh IMAGE Y HEIGHT OUT : crop a horizontal slice of a full-page screenshot
/usr/bin/python3 - "$@" <<'PY'
import sys
from PIL import Image
src, y, h, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
im = Image.open(src); im.crop((0, y, im.width, min(im.height, y + h))).save(out)
PY
