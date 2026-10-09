import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MONOREPO_ONLY_MODULE_IDS, TEMPLATE_COMMENTED_MODULES, TEMPLATE_CONTENT_TRANSFORMS } from '../../../../scripts/template-sync.ts'

// `packages/create-app/template/src/modules.ts` deliberately diverges from
// `apps/mercato/src/modules.ts`: design_system/example are stripped outright, while
// channel_discord stays commented out with a maintainer-facing byte-budget explanation
// (#5598). `TEMPLATE_CONTENT_TRANSFORMS['modules.ts']` is the only thing standing between
// the two files silently drifting apart again.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const APP_MODULES_FILE = path.join(REPO_ROOT, 'apps', 'mercato', 'src', 'modules.ts')
const TEMPLATE_MODULES_FILE = path.join(REPO_ROOT, 'packages', 'create-app', 'template', 'src', 'modules.ts')

test('modules.ts transform output matches the committed template file byte-for-byte', () => {
  const appContent = fs.readFileSync(APP_MODULES_FILE, 'utf8')
  const templateContent = fs.readFileSync(TEMPLATE_MODULES_FILE, 'utf8')

  const transform = TEMPLATE_CONTENT_TRANSFORMS['modules.ts']
  assert.ok(transform, 'TEMPLATE_CONTENT_TRANSFORMS is missing a modules.ts transform')

  const transformed = transform(appContent)
  assert.equal(
    transformed,
    templateContent,
    'Transformed apps/mercato/src/modules.ts no longer matches packages/create-app/template/src/modules.ts — run `yarn template:sync:fix`.',
  )
})

test('modules.ts transform keeps every commented module commented out, not deleted', () => {
  const appContent = fs.readFileSync(APP_MODULES_FILE, 'utf8')
  const transform = TEMPLATE_CONTENT_TRANSFORMS['modules.ts']
  const transformed = transform(appContent)

  const moduleIds = Object.keys(TEMPLATE_COMMENTED_MODULES)
  assert.ok(moduleIds.length > 0, 'TEMPLATE_COMMENTED_MODULES must describe at least one module')

  for (const moduleId of moduleIds) {
    const registration = `{ id: '${moduleId}',`
    assert.match(
      transformed,
      new RegExp(`^\\s*// ${escapeForRegExp(registration)}`, 'm'),
      `${moduleId} must stay as a commented-out registration in the template, not be stripped entirely`,
    )
    assert.doesNotMatch(
      transformed,
      new RegExp(`^ {2}${escapeForRegExp(registration)}`, 'm'),
      `${moduleId} must not remain enabled in the template`,
    )
  }
})

test('monorepo-only modules ship neither their source nor their registration in the template', () => {
  const appContent = fs.readFileSync(APP_MODULES_FILE, 'utf8')
  const transformed = TEMPLATE_CONTENT_TRANSFORMS['modules.ts'](appContent)
  const templateSourceRoot = path.join(REPO_ROOT, 'packages', 'create-app', 'template', 'src')
  const templateFiles = fs.readdirSync(templateSourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))

  for (const moduleId of MONOREPO_ONLY_MODULE_IDS) {
    assert.ok(appContent.includes(`{ id: '${moduleId}',`), `${moduleId} must stay registered in apps/mercato`)
    assert.ok(!transformed.includes(moduleId), `${moduleId} must not appear in the template modules.ts`)
    assert.ok(
      !fs.existsSync(path.join(templateSourceRoot, 'modules', moduleId)),
      `${moduleId} source must not be copied into the template`,
    )
    const referencing = templateFiles.filter((file) => fs.readFileSync(file, 'utf8').includes(moduleId))
    assert.deepEqual(referencing, [], `template files must not reference ${moduleId}`)
  }
})
