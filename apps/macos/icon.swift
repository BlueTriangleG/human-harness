// An HH app's icon when no picture is given, drawn at 1024 px (build.sh compiles and runs it; not part of the app):
//   icon letter <letter> <#rrggbb> <out.png>   a role's: the first letter of its name on the colour its id gives
//   icon human <out.png>                         Human.app's: the menu bar's dots, one per role, on a dark tile
import AppKit

func png(_ out: String, _ draw: () -> Void) {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw()
  NSGraphicsContext.restoreGraphicsState()
  guard let data = rep.representation(using: .png, properties: [:]) else { exit(1) }
  do { try data.write(to: URL(fileURLWithPath: out)) } catch { FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(1) }
}

func color(_ hex: String) -> NSColor {
  var v: UInt64 = 0
  let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
  guard s.count == 6, Scanner(string: s).scanHexInt64(&v) else { return NSColor(srgbRed: 0.11, green: 0.42, blue: 0.35, alpha: 1) }
  return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

/** the macOS icon grid: an 824 px rounded square in the 1024 canvas, a soft shadow under it, lit a little from the top */
func tile(_ fill: NSColor) {
  let shape = NSBezierPath(roundedRect: NSRect(x: 100, y: 110, width: 824, height: 824), xRadius: 185, yRadius: 185)
  NSGraphicsContext.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowOffset = NSSize(width: 0, height: -12)
  shadow.shadowBlurRadius = 28
  shadow.shadowColor = NSColor(white: 0, alpha: 0.28)
  shadow.set()
  fill.setFill()
  shape.fill()
  NSGraphicsContext.restoreGraphicsState()
  NSGradient(starting: fill.blended(withFraction: 0.14, of: .white)!, ending: fill.blended(withFraction: 0.06, of: .black)!)!.draw(in: shape, angle: -90)
}

let a = CommandLine.arguments
switch a.count > 1 ? a[1] : "" {
case "letter" where a.count == 5:
  png(a[4]) {
    tile(color(a[3]))
    let base = NSFont.systemFont(ofSize: 520, weight: .semibold)
    let font = base.fontDescriptor.withDesign(.serif).flatMap { NSFont(descriptor: $0, size: 520) } ?? base
    let text = NSAttributedString(string: a[2], attributes: [.font: font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): NSColor.white.cgColor])
    // centred on the glyph's own ink, not its line box: a capital sits in the middle, not high
    let line = CTLineCreateWithAttributedString(text)
    let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.textPosition = CGPoint(x: 512 - ink.midX, y: 522 - ink.midY)
    CTLineDraw(line, ctx)
  }
case "human" where a.count == 3:
  png(a[2]) {
    tile(color("#18221e"))
    // three roles' dots, as in the menu bar: at work, idle, asleep
    for (i, hex) in ["#4a8fe0", "#3fb37f", "#9aa49f"].enumerated() {
      color(hex).setFill()
      NSBezierPath(ovalIn: NSRect(x: 232 + CGFloat(i) * 210, y: 417, width: 140, height: 140)).fill()
    }
  }
default:
  FileHandle.standardError.write(Data("usage: icon letter <letter> <#rrggbb> <out.png> | icon human <out.png>\n".utf8))
  exit(2)
}
