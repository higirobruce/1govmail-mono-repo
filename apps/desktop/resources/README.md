# Desktop App Resources

Place your icon assets here before packaging:

| File | Size | Used for |
|---|---|---|
| `icon.icns` | macOS multi-resolution | macOS app icon (Dock, Finder) |
| `icon.ico` | Windows multi-resolution | Windows app icon (taskbar, installer) |
| `icon.png` | 512×512 minimum | Linux app icon |
| `tray-icon.png` | 16×16 or 22×22 | System tray icon (Windows/Linux) |
| `tray-icon-template.png` | 16×16 | System tray icon — macOS template image (must be white + transparent, named `*Template*`) |
| `tray-icon-template@2x.png` | 32×32 | Retina tray icon for macOS |

## Generating Icons

If you have a 1024×1024 PNG source image, you can use:

```bash
# macOS — requires Xcode command line tools
iconutil -c icns icon.iconset   # or use https://github.com/nickvdyck/nuget-icon

# Windows .ico — use ImageMagick
magick convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico

# Or use an online converter: https://cloudconvert.com/png-to-icns
```

The app will fall back to the default Electron icon if these files are absent.
