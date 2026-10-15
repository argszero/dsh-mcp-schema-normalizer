/**
 * The package's own claims, checked against the files that make them.
 *
 * A peer range, a bundle patch and the lines a probe script walks are three
 * statements about one thing, written in three files by hand. Nothing in the
 * build makes them agree, and a disagreement is invisible until someone installs
 * the package on the line nothing tested.
 *
 * @module test/packaging.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as plugin from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const probe = readFileSync(join(root, 'scripts', 'probe-lines.sh'), 'utf8')

/** The release lines `scripts/probe-lines.sh` walks when it is given no argument. */
const LINES = [...probe.matchAll(/DEFAULT_LINES=\(([^)]*)\)/g)]
  .flatMap(match => match[1].trim().split(/\s+/))
  .filter(entry => entry.length > 0)

test('the probe script walks exactly the lines the peer range admits', () => {
  assert.deepEqual(LINES, ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.2'])
  const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
  // Every line the script installs has to be inside the range, or the probe is
  // measuring a tree no consumer can produce.
  for (const line of LINES) {
    assert.ok(range.includes(`<${line}`) || range.includes(`>=${line}`), `${line} is not named by the range ${range}`)
  }
  // The range's floor is the oldest line probed — a floor below it would admit a
  // line nothing ran against.
  assert.ok(range.startsWith('>=0.1.7-rc.2 '), `the range ${range} does not start at the oldest probed line`)
})

test('the README states the same three lines as the manifest', () => {
  for (const line of LINES) {
    assert.ok(readme.includes(line), `the README does not name the probed line ${line}`)
  }
  assert.ok(readme.includes(manifest.peerDependencies['@deepseek-ai/cordis']))
})

test('the bundle patch exists and mounts this package', () => {
  const patch = manifest.dsh.bundle.patch
  assert.equal(patch, './cordis.patch.yml')
  const file = join(root, patch)
  assert.ok(existsSync(file), `${patch} is missing`)
  const text = readFileSync(file, 'utf8')
  // The row is resolved by package name, so a rename that misses the patch ships
  // a bundle that activates nothing.
  assert.ok(text.includes(`name: '${manifest.name}'`), 'the patch does not name this package')
  assert.ok(text.includes(`id: ${plugin.name}`), 'the patch id does not match the plugin name')
})

test('every path the package promises to ship is there after a build', () => {
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  assert.ok(manifest.files.includes('README.md'))
  assert.ok(existsSync(join(root, 'LICENSE')), 'LICENSE is missing')
  assert.ok(existsSync(join(root, manifest.main)), `${manifest.main} is missing`)
  assert.ok(existsSync(join(root, manifest.types)), `${manifest.types} is missing`)
  // The published entry is the built one: a `main` that pointed at `src/` would
  // ship TypeScript to a Node that cannot read it.
  assert.ok(manifest.main.startsWith('lib/'), `main is ${manifest.main}`)
  assert.equal(manifest.publishConfig.access, 'public')
})

test('the plugin declares the capability it shadows and the seam it uses', () => {
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(plugin.name, 'mcp-schema-normalizer')
  // A `Config` on the default export is the defect this family has shipped: a
  // plain object has no `~standard`, and cordis reads it before `apply` runs.
  assert.equal(plugin.default.Config, undefined)
  assert.equal(typeof plugin.default.apply, 'function')
  // The exports the README's snapshot section names have to be reachable.
  assert.equal(typeof plugin.normalizeSchema, 'function')
  assert.equal(typeof plugin.normalizeConfig, 'function')
  assert.equal(plugin.MAX_DEPTH, 32)
})
