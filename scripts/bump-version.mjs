import { readFileSync, writeFileSync } from 'node:fs'

const configPath = new URL('../apps/web/src-tauri/tauri.conf.json', import.meta.url)
const cargoPath = new URL('../apps/web/src-tauri/Cargo.toml', import.meta.url)

try {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--dry-run')) {
    throw new Error('Usage: node scripts/bump-version.mjs [--dry-run]')
  }

  const configText = readFileSync(configPath, 'utf8')
  const cargoText = readFileSync(cargoPath, 'utf8')
  const currentVersion = JSON.parse(configText).version
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(currentVersion)
  if (!parts) {
    throw new Error(`Expected a major.minor.patch app version, got ${currentVersion}`)
  }

  // Restrict the edit to the desktop package, leaving dependency versions alone.
  const packageSection = cargoText.match(
    /^\[package\][^\S\r\n]*\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/m,
  )
  const cargoVersionPattern = /^(\s*version\s*=\s*")([^"]+)(")/m
  const cargoVersion = packageSection?.[0].match(cargoVersionPattern)?.[2]
  if (cargoVersion !== currentVersion) {
    throw new Error(
      `Versions must match before bumping: tauri.conf.json=${currentVersion}, Cargo.toml=${cargoVersion}`,
    )
  }

  const nextVersion = `${parts[1]}.${BigInt(parts[2]) + 1n}.0`
  const configVersionPattern = /("version"\s*:\s*")([^"]+)(")/
  const updatedConfig = configText.replace(
    configVersionPattern,
    (_, prefix, _version, suffix) => `${prefix}${nextVersion}${suffix}`,
  )
  const updatedPackage = packageSection[0].replace(
    cargoVersionPattern,
    (_, prefix, _version, suffix) => `${prefix}${nextVersion}${suffix}`,
  )
  const updatedCargo = cargoText.replace(packageSection[0], () => updatedPackage)

  if (args.includes('--dry-run')) {
    console.log(`Would bump desktop app version: ${currentVersion} -> ${nextVersion}`)
  } else {
    writeFileSync(configPath, updatedConfig)
    try {
      writeFileSync(cargoPath, updatedCargo)
    } catch (error) {
      writeFileSync(configPath, configText)
      throw error
    }
    console.log(`Bumped desktop app version: ${currentVersion} -> ${nextVersion}`)
  }
} catch (error) {
  console.error(`Version bump failed: ${error.message}`)
  process.exitCode = 1
}
