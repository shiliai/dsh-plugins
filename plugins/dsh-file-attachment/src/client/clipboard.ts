export function clipboardFiles(data: DataTransfer | null): File[] {
  if (data === null) return []
  const candidates: File[] = []
  for (let index = 0; index < data.files.length; index += 1) {
    const file = data.files.item(index)
    if (file !== null) candidates.push(file)
  }
  for (let index = 0; index < data.items.length; index += 1) {
    const item = data.items[index]
    if (item === undefined) continue
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file !== null) candidates.push(file)
  }
  const objects = new Set<File>()
  const fingerprints = new Set<string>()
  return candidates.filter(file => {
    if (objects.has(file)) return false
    objects.add(file)
    const fingerprint = [file.name, file.size, file.type, file.lastModified].join('\u0000')
    if (fingerprints.has(fingerprint)) return false
    fingerprints.add(fingerprint)
    return true
  })
}
