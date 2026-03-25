# App Icons

Replace these placeholder files with actual app icons:

## Required Files

- **icon.icns** - macOS app icon (512x512 recommended, multiple sizes)
- **icon.ico** - Windows app icon (256x256 with multiple sizes embedded)
- **icon.png** - Linux app icon (512x512 PNG)
- **dmg-background.png** - macOS DMG installer background (540x380)

## Creating Icons

### From a source PNG (1024x1024):

```bash
# macOS - create icns from png
mkdir icon.iconset
sips -z 16 16 icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32 icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32 icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64 icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128 icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256 icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256 icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512 icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512 icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
rm -rf icon.iconset

# Windows - use ImageMagick or online converter
convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

### Online Tools
- https://www.icoconverter.com/ - PNG to ICO
- https://cloudconvert.com/png-to-icns - PNG to ICNS
