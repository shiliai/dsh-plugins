import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * E2E for user-reported issues (2026-09-29):
 * 1. Notes created through a conversation (i.e. written to the vault on disk)
 *    must show up in the workbench vault tree, and there must be a refresh
 *    button.
 * 2. A newly created note must open in the note/preview panes — also while
 *    another note has unsaved edits (the pending-discard prompt must be
 *    visible, never swallow clicks, and never deadlock note opening).
 * Plus: the workbench "+" quick opener searches the vault live and Escape
 * must not close the workbench underneath it.
 */

const VAULT = process.env.DSH_OBSIDIAN_E2E_VAULT ?? ''

test('vault tree reflects on-disk notes and opens them in the workbench', async ({ page }) => {
  test.skip(VAULT === '', 'harness supplies DSH_OBSIDIAN_E2E_VAULT')
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
    const chooseWorkspace = page.getByRole('button', { name: 'Choose workspace', exact: true })
    await chooseWorkspace.click()
    const workspacePicker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await workspacePicker.getByLabel('Edit path').fill(VAULT)
    await workspacePicker.getByLabel('Edit path').press('Enter')
    await workspacePicker.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(page.getByLabel('Obsidian notes')).toBeVisible({ timeout: 15_000 })
  }
  await page.getByLabel('Obsidian notes').click()
  await expect(page.locator('[data-dsh-obsidian-workbench]')).toBeVisible()

  // A note that existed before the workbench opened is visible and openable.
  const fixtureNote = page.getByRole('treeitem', { name: /Home/u })
  await expect(fixtureNote).toBeVisible()
  await fixtureNote.click()
  await expect(page.getByRole('region', { name: 'Note editor' }).locator('textarea')).toBeVisible()

  // Issue 1: a note written on disk by "the conversation" appears in the tree
  // via auto-refresh (interval is 5s; allow two ticks plus latency).
  await writeFile(join(VAULT, 'Fresh-from-chat.md'), '# Fresh from chat\n\ncreated while the workbench was open\n', 'utf8')
  const fresh = page.locator('[data-note-path="Fresh-from-chat.md"]')
  await expect(fresh).toBeVisible({ timeout: 12_000 })

  // Issue 2: the fresh note opens in the editor/preview panes.
  await fresh.getByRole('button', { name: 'Fresh-from-chat', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Note editor' }).locator('textarea')).toHaveValue(/Fresh from chat/u, { timeout: 8_000 })
  await expect(page.getByRole('region', { name: 'Preview' })).toContainText('created while the workbench was open')

  // Issue 2, variant: with an unsaved edit, clicking another note must still
  // open it (or show the discard dialog) — never swallow the click silently.
  const editor = page.getByRole('region', { name: 'Note editor' }).locator('textarea')
  await editor.fill('# Fresh from chat\n\nunsaved local edit\n')
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await page.getByLabel('New note name (extension .md is added automatically)').fill('Second note')
  await page.getByLabel('New note name (extension .md is added automatically)').press('Enter')
  // After in-place creation the store is not dirty; open Home again.
  await expect(page.locator('[data-note-path="Home.md"]')).toBeVisible({ timeout: 12_000 })
  await page.locator('[data-note-path="Home.md"]').getByRole('button', { name: 'Home', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Note editor' }).locator('textarea')).toBeVisible()

  // The workbench "+" quick opener searches the vault live on the server, so
  // it opens notes the tree has not rendered yet.
  await page.getByRole('button', { name: 'Open a note from the vault', exact: true }).click()
  const quickOpen = page.getByRole('dialog', { name: 'Quick open note' })
  await expect(quickOpen).toBeVisible()
  await quickOpen.getByLabel('Search notes to open').fill('Fresh from chat')
  await quickOpen.getByRole('button', { name: 'Fresh-from-chat.md', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Note editor' }).locator('textarea')).toHaveValue(/Fresh from chat/u, { timeout: 8_000 })
  // Escape must not close the workbench underneath the picker.
  await page.getByRole('button', { name: 'Open a note from the vault', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Quick open note' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Quick open note' })).toBeHidden()
  await expect(page.locator('[data-dsh-obsidian-workbench]')).toBeVisible()
})
