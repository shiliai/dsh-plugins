import { expect, test } from '@playwright/test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

/**
 * E2E for the Vault browser's entry context menu (issue #146): copying the
 * absolute path, opening an entry with a host-resolved app, and reading entry
 * properties.
 *
 * "Open with" hands a path to a desktop application, so the launch request is
 * intercepted here: the spec verifies the client wiring without opening
 * anything on the machine running the suite.
 */

const VAULT = process.env.DSH_OBSIDIAN_E2E_VAULT ?? ''

test('entry context menu copies the absolute path, opens with, and shows properties', async ({ page, context }, testInfo) => {
  test.skip(VAULT === '', 'harness supplies DSH_OBSIDIAN_E2E_VAULT')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(process.env.DSH_OBSIDIAN_E2E_ACCESS_URL ?? '/')
  const testingNotice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  if (await testingNotice.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
    await testingNotice.getByRole('button', { name: 'Continue' }).click()
  }
  const configureLater = page.getByRole('button', { name: /configure later/i })
  if (await configureLater.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
    await configureLater.click()
  }
  if (await page.getByLabel('Obsidian notes').count() === 0) {
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    const workspacePicker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await workspacePicker.getByLabel('Edit path').fill(VAULT)
    await workspacePicker.getByLabel('Edit path').press('Enter')
    await workspacePicker.getByRole('button', { name: 'Open', exact: true }).click()
  }
  const workbench = page.locator('[data-dsh-obsidian-workbench]')
  await page.getByLabel('Obsidian notes').click()
  await expect(workbench).toBeVisible()
  const homeRow = workbench.getByRole('treeitem', { name: /Home/u }).first()
  await expect(homeRow).toBeVisible({ timeout: 15_000 })
  // The host reports the canonical Vault root (macOS resolves /var to /private/var).
  const absolute = join(realpathSync(VAULT), 'Home.md')

  // ── Copy absolute path ────────────────────────────────────────────────
  await homeRow.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Copy absolute path' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Open with' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Properties' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Copy absolute path' }).click()
  await expect(page.getByText(`Copied ${absolute}`, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(absolute)

  // ── Open with (launch intercepted) ────────────────────────────────────
  await page.route('**/dsh-obsidian/api/open', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ opened: true }),
  }))
  await homeRow.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Open with' }).click()
  const openers = page.getByRole('menu')
  // The label differs on Linux ("Default application").
  const defaultApp = openers.getByRole('menuitem', { name: /^Default app(?:lication)?$/u })
  await expect(defaultApp).toBeVisible()
  await expect(openers.getByRole('menuitem', { name: 'Open with' })).toBeVisible()
  await defaultApp.click()
  await expect(page.getByText(/^Opened Home\.md in Default app(?:lication)?\.$/u)).toBeVisible()

  // ── Escape unwinds one layer, never Obsidian mode ─────────────────────
  await homeRow.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Open with' }).click()
  await expect(page.getByRole('menu').getByRole('menuitem', { name: /^Default app/u })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('vault-context-menu.png') })
  await page.keyboard.press('Escape')
  const rootMenu = page.getByRole('menu')
  await expect(rootMenu.getByRole('menuitem', { name: 'Copy absolute path' })).toBeVisible()
  await expect(workbench).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(workbench).toBeVisible()
  await expect(homeRow).toBeVisible()

  // ── Properties ────────────────────────────────────────────────────────
  await homeRow.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Properties' }).click()
  const dialog = page.getByRole('dialog', { name: 'Properties of Home.md' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Home.md')
  await expect(dialog).toContainText(absolute)
  await expect(dialog.getByRole('button', { name: 'Copy absolute path' })).toBeVisible()
  // Note statistics and tags are read from the note itself.
  await expect(dialog).toContainText('Lines')
  await expect(dialog).toContainText('Tags')
  await page.screenshot({ path: testInfo.outputPath('vault-entry-properties.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // Escape closes the dialog only: it must not exit Obsidian mode underneath.
  await expect(workbench).toBeVisible()
  await expect(homeRow).toBeVisible()

  // ── Properties for a directory: counts instead of text statistics ─────
  await workbench.getByRole('button', { name: 'Projects 1', exact: true }).click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Properties' }).click()
  const directoryDialog = page.getByRole('dialog', { name: 'Properties of Projects' })
  await expect(directoryDialog).toBeVisible()
  await expect(directoryDialog).toContainText('Folder')
  await expect(directoryDialog).toContainText('Subfolders')
  await expect(directoryDialog).not.toContainText('Lines')
})
