import { expect, test } from '@playwright/test'

test('keeps note workflow and composer routing usable across session transitions', async ({ page }, testInfo) => {
  test.skip(process.env.DSH_OBSIDIAN_E2E_COMMIT === undefined || process.env.DSH_OBSIDIAN_E2E_PACKAGE_SHA === undefined || process.env.DSH_OBSIDIAN_E2E_SESSION_ID === undefined, 'rc.6 harness supplies immutable identities')
  expect(process.env.DSH_OBSIDIAN_E2E_COMMIT).toMatch(/^[0-9a-f]{40}$/u)
  expect(process.env.DSH_OBSIDIAN_E2E_PACKAGE_SHA).toMatch(/^[0-9a-f]{64}$/u)
  await testInfo.attach('immutable-subject.json', {
    body: JSON.stringify({ commit: process.env.DSH_OBSIDIAN_E2E_COMMIT, packageSha256: process.env.DSH_OBSIDIAN_E2E_PACKAGE_SHA, sessionId: process.env.DSH_OBSIDIAN_E2E_SESSION_ID }),
    contentType: 'application/json',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const testingNotice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  if (await testingNotice.isVisible().catch(() => false)) {
    await testingNotice.getByRole('button', { name: 'Continue' }).click()
  }
  const configureLater = page.getByRole('button', { name: /configure later/i })
  if (await configureLater.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
    await configureLater.click()
  }
  await page.getByLabel('Obsidian notes').click()
  await page.getByRole('treeitem', { name: /Home/u }).click()
  await expect(page.getByLabel('Note editor')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Atlas Vault' })).toBeVisible()
  await expect(page.getByLabel('Note editor').locator('input[type="checkbox"]').first()).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('desktop-vault-note.png'), fullPage: true })
  await page.getByLabel('Add note to chat').click()
  const composer = page.getByRole('textbox').filter({ hasNot: page.getByLabel(/Edit /u) })
  await expect(composer.first()).toHaveValue(/Obsidian note/u)
  await page.getByLabel('Edit').click()
  await page.getByLabel(/Edit Home/u).fill('# Edited in isolated rc.6 fixture\n\n<style>body { display: none }</style>\n<div style="position:fixed"><button>Unsafe control</button></div>\n\n- [ ] Safe task')
  await page.getByLabel('Save').click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.getByLabel('Preview').click()
  await expect(page.getByRole('heading', { name: 'Edited in isolated rc.6 fixture' })).toBeVisible()
  await expect(page.getByText('Unsafe control')).toHaveCount(0)
  await expect(page.locator('body')).toBeVisible()
  await expect(page.getByLabel('Note editor').locator('input[type="checkbox"]').first()).toBeDisabled()
  await page.getByRole('button', { name: /send|submit/u }).click()
  await expect(page.getByLabel('Note editor')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByLabel('Note editor')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('mobile-vault-note.png'), fullPage: true })
})
