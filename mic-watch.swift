// Prints {"apps":[bundle IDs capturing the mic],"muted":{bundle ID: true/false}} once per change.
// apps: CoreAudio process objects (macOS 14+), so it reports per-app use, not just "mic busy".
// muted: read from the app's own mute button through Accessibility (needs that permission);
// an app with no readable mute button is left out, which means "record".
import AppKit
import ApplicationServices
import CoreAudio
import Foundation

func prop<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ value: inout T) -> Bool {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr
}

func appsUsingMic() -> [String] {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }

  var out = Set<String>()
  for id in ids {
    var running: UInt32 = 0
    guard prop(id, kAudioProcessPropertyIsRunningInput, &running), running != 0 else { continue }
    var bundle: CFString = "" as CFString
    var pid: pid_t = 0
    if prop(id, kAudioProcessPropertyBundleID, &bundle), !(bundle as String).isEmpty {
      out.insert(bundle as String)
    } else if prop(id, kAudioProcessPropertyPID, &pid) {
      out.insert("pid:\(pid)")
    }
  }
  return out.sorted()
}

// --- Mute button (Zoom "Unmute audio", Meet "Turn on microphone", Teams "Unmute", ...) ---
// shortcut: English labels only, matched by text; add patterns here when an app or language is missed.
let mutedRe = try! NSRegularExpression(pattern: "^(unmute|turn on microphone)\\b", options: .caseInsensitive)
let unmutedRe = try! NSRegularExpression(pattern: "^(mute|turn off microphone)\\b(?!.*\\b(all|everyone|notifications?|chat|participants?)\\b)", options: .caseInsensitive)

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func label(_ el: AXUIElement) -> String {
  [kAXDescriptionAttribute, kAXTitleAttribute].compactMap { attr(el, $0) as? String }.first { !$0.isEmpty } ?? ""
}

func muteState(_ text: String) -> Bool? {
  let r = NSRange(text.startIndex..., in: text)
  if mutedRe.firstMatch(in: text, range: r) != nil { return true }
  if unmutedRe.firstMatch(in: text, range: r) != nil { return false }
  return nil
}

func findMuteButton(_ el: AXUIElement, _ budget: inout Int) -> AXUIElement? {
  budget -= 1
  if budget < 0 { return nil }
  let role = attr(el, kAXRoleAttribute) as? String ?? ""
  if ["AXButton", "AXCheckBox", "AXMenuItem"].contains(role), muteState(label(el)) != nil { return el }
  for child in attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
    if let hit = findMuteButton(child, &budget) { return hit }
  }
  return nil
}

var buttons: [String: AXUIElement] = [:] // found once, then only its label is re-read
var lastScan: [String: Date] = [:]

func muted(_ bundle: String) -> Bool? {
  if let b = buttons[bundle], let state = muteState(label(b)) { return state }
  buttons[bundle] = nil
  guard Date().timeIntervalSince(lastScan[bundle] ?? .distantPast) > 3, // full tree walks are slow
        let pid = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.processIdentifier else { return nil }
  lastScan[bundle] = Date()
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) // Chrome/Electron: expose web page buttons
  var budget = 5000
  guard let b = findMuteButton(app, &budget) else { return nil }
  FileHandle.standardError.write("mic-watch: mute button in \(bundle): \"\(label(b))\"\n".data(using: .utf8)!)
  buttons[bundle] = b
  return muteState(label(b))
}

struct State: Equatable { var apps: [String]; var muted: [String: Bool] }

_ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
setvbuf(stdout, nil, _IOLBF, 0)
var watched = Set<String>() // apps that used the mic; kept while running, since some release it on mute
var last: State? = nil
while true {
  let apps = appsUsingMic()
  watched.formUnion(apps.filter { !$0.hasPrefix("pid:") })
  watched = watched.filter { !NSRunningApplication.runningApplications(withBundleIdentifier: $0).isEmpty }
  var mutes: [String: Bool] = [:]
  for b in watched { mutes[b] = muted(b) }
  let now = State(apps: apps, muted: mutes)
  if now != last {
    let data = try! JSONSerialization.data(withJSONObject: ["apps": now.apps, "muted": now.muted])
    print(String(data: data, encoding: .utf8)!)
    last = now
  }
  Thread.sleep(forTimeInterval: 0.5)
}
