import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * E2E for the 0.9.0 workbench redesign (docs/design-obsidian-mode-exit-and-workspace.md):
 * 1. A workbench header bar with a textual exit button, a pane segmented
 *    control, and (when the host exposes the faces) a workspace chip.
 * 2. Hiding every content pane is a legal pure-chat layout with a
 *    dismissible restore bar — never the old centered dead-end card.
 * 3. Exiting the mode shows a non-modal exit toast with an undo action that
 *    reopens the workbench with the previous layout; drafts survive.
 */

const VAULT = process.env.DSH_OBSIDIAN_E2E_VAULT ?? ''

test('workbench header exits cleanly, restores panes, and keeps drafts', async ({ page }) => {
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
  const workbench = page.locator('[data-dsh-obsidian-workbench]')
  await expect(workbench).toBeVisible()

  // §4: the header bar carries a textual exit button and the segmented control.
  const exitButton = workbench.getByRole('button', { name: '退出 Obsidian 模式' })
  await expect(exitButton).toBeVisible()
  const segmented = page.getByRole('group', { name: '面板开关' })
  await expect(segmented).toBeVisible()
  await expect(segmented.getByRole('button', { name: 'Vault' })).toHaveAttribute('aria-pressed', 'true')

  // Open a note and type a draft — the exit toast must report draft retention.
  await writeFile(join(VAULT, 'Exit-Draft.md'), '# Exit draft\n', 'utf8')
  await page.getByRole('button', { name: 'Refresh vault' }).click()
  await page.locator('[data-note-path="Exit-Draft.md"]').getByRole('button', { name: 'Exit-Draft', exact: true }).click()
  const editor = page.getByRole('region', { name: 'Note editor' }).locator('textarea')
  await expect(editor).toHaveValue(/Exit draft/u, { timeout: 8_000 })
  await editor.fill('# Exit draft edited')

  // §5.1 path A: hide every content pane via the segmented control — a legal
  // pure-chat layout with a restore bar, no centered dead-end card.
  await segmented.getByRole('button', { name: 'Vault' }).click()
  await segmented.getByRole('button', { name: '编辑器' }).click()
  await segmented.getByRole('button', { name: '预览' }).click()
  const restoreBar = page.locator('[data-dsh-obsidian-workbench]').getByText('已隐藏全部笔记面板')
  await expect(restoreBar).toBeVisible()
  await expect(page.getByText('All workbench panes are hidden.')).toHaveCount(0)
  await expect(page.getByText('Restore all panes')).toHaveCount(0)

  // §5.3: exit — the footer toast appears, names the retained drafts…
  await exitButton.click()
  await expect(workbench).toHaveCount(0)
  const toast = page.getByRole('status').filter({ hasText: '已退出 Obsidian 模式' })
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('未保存草稿已保留')

  // …and 撤销 reopens the workbench with the draft intact.
  await toast.getByRole('button', { name: '撤销' }).click()
  await expect(workbench).toBeVisible()

  // The undo restores the pre-exit layout (content panes hidden — path A
  // state), so the restore bar offers bringing them back.
  const restoreBarReopened = workbench.getByText('已隐藏全部笔记面板', { exact: true })
  await expect(restoreBarReopened).toBeVisible()
  await workbench.getByRole('button', { name: '恢复笔记面板' }).click()
  // §5.2: the draft survived the exit/reopen cycle.
  await expect(page.getByRole('region', { name: 'Note editor' }).locator('textarea')).toHaveValue(/Exit draft edited/u, { timeout: 8_000 })
  await expect(page.getByRole('region', { name: 'Vault', exact: true })).toBeVisible()
  await expect(restoreBarReopened).toHaveCount(0)
})
