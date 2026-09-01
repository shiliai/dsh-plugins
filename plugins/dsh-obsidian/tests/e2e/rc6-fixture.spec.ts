import { expect, test } from '@playwright/test'

test('keeps note workflow and composer routing usable across session transitions', async ({ page }, testInfo) => {
  test.skip(process.env.DSH_OBSIDIAN_E2E_COMMIT === undefined || process.env.DSH_OBSIDIAN_E2E_PACKAGE_SHA === undefined || process.env.DSH_OBSIDIAN_E2E_SESSION_ID === undefined, 'rc.6 harness supplies immutable identities')
  expect(process.env.DSH_OBSIDIAN_E2E_COMMIT).toMatch(/^[0-9a-f]{40}$/u)
  expect(process.env.DSH_OBSIDIAN_E2E_PACKAGE_SHA).toMatch(/^[0-9a-f]{64}$/u)
  const subject = process.env.DSH_OBSIDIAN_E2E_COMMIT?.slice(0, 12) ?? 'unknown'
  await testInfo.attach('immutable-subject.json', {
    body: JSON.stringify({ commit: process.env.DSH_OBSIDIAN_E2E_COMMIT, packageSha256: process.env.DSH_OBSIDIAN_E2E_PACKAGE_SHA, sessionId: process.env.DSH_OBSIDIAN_E2E_SESSION_ID }),
    contentType: 'application/json',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const testingNotice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  if (await testingNotice.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
    await testingNotice.getByRole('button', { name: 'Continue' }).click()
  }
  const configureLater = page.getByRole('button', { name: /configure later/i })
  if (await configureLater.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
    await configureLater.click()
  }
  await page.getByLabel('Obsidian notes').click()
  await page.getByLabel('Select vault directory').click()
  await expect(page.getByRole('region', { name: 'Select vault directory' })).toBeVisible()
  await page.getByRole('button', { name: 'Projects' }).click()
  await page.getByLabel('Parent directory').click()
  await page.getByLabel('Cancel vault selection').click()

  await page.getByRole('treeitem', { name: /Home/u }).click()
  await expect(page.getByLabel('Note editor')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Atlas Vault' })).toBeVisible()
  await expect(page.getByLabel('Note editor').locator('input[type="checkbox"]').first()).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath(`${subject}-desktop-vault-note.png`), fullPage: true })
  await page.getByLabel('Add note to chat').click()
  const composer = page.locator('textarea').first()
  await expect(composer).toHaveValue(/type: note[\s\S]*note: "Home\.md"[\s\S]*absolutePath:/u)

  await page.getByRole('tab', { name: 'Tags' }).click()
  const homeTag = page.getByRole('button', { name: '#home 1', exact: true })
  await expect(homeTag).toBeVisible()
  await homeTag.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Add to chat' }).click()
  await expect(composer).toHaveValue(/\[Obsidian context\][\s\S]*type: tag[\s\S]*tag: #home/u)

  await page.getByRole('tab', { name: 'Notes' }).click()
  const projects = page.getByRole('button', { name: 'Projects 1', exact: true })
  await projects.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Add to chat' }).click()
  await expect(composer).toHaveValue(/type: directory[\s\S]*directory: "Projects"[\s\S]*absolutePath:/u)

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel(/Edit Home/u).fill('# Edited in isolated rc.6 fixture\n\n<style>body { display: none }</style>\n<div style="position:fixed"><button>Unsafe control</button></div>\n\n- [ ] Safe task')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Edited in isolated rc.6 fixture' })).toBeVisible()
  await expect(page.getByText('Unsafe control')).toHaveCount(0)
  await expect(page.locator('body')).toBeVisible()
  await expect(page.getByLabel('Note editor').locator('input[type="checkbox"]').first()).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Open sidebar', exact: true })).toBeVisible()
  await expect(page.locator('[data-sidebar-collapsed="true"]')).toBeVisible()
  await expect(page.getByLabel('Obsidian vault')).toBeHidden()
  await expect(page.getByLabel('Note editor')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`${subject}-mobile-vault-note.png`), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByLabel('Note editor')).toBeVisible()
})
