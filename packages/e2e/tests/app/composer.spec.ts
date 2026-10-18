import { composer, expect, expectIdle, newSessionInProject, openApp, PNG_1PX, sendPrompt, test } from '../../support/app.ts';

/**
 * Dispatches a paste carrying one image. Firefox's ClipboardEvent constructor ignores the `clipboardData` init member
 * (event.clipboardData stays null), so the DataTransfer is attached to a plain event instead; this works in every engine.
 */
async function pasteImage(page: import('@playwright/test').Page, name: string) {
  await page.evaluate(([b64, fileName]) => {
    const bytes = Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], fileName!, { type: 'image/png' }));
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    document.querySelector('textarea[aria-label="Message Claude"]')!.dispatchEvent(ev);
  }, [PNG_1PX, name]);
}

test.describe('composer', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
  });

  test('typing / opens the command palette and Enter inserts the chosen command', async ({ page }) => {
    await composer(page).fill('/');
    const list = page.getByRole('listbox', { name: 'Commands' });
    await expect(list).toBeVisible();
    for (const c of ['/compact', '/review', '/init', '/mock-skill']) await expect(list).toContainText(c);
    await composer(page).fill('/rev');
    await expect(list.getByRole('option')).toHaveCount(1);
    await composer(page).press('Enter');
    await expect(composer(page)).toHaveValue('/review ');
    await expect(list).toHaveCount(0);
  });

  test('Escape closes the slash palette without changing the text', async ({ page }) => {
    await composer(page).fill('/co');
    await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
    await composer(page).press('Escape');
    await expect(page.getByRole('listbox', { name: 'Commands' })).toHaveCount(0);
    await expect(composer(page)).toHaveValue('/co');
  });

  test('@ mention completes a project file path', async ({ page }) => {
    await composer(page).fill('read @exa');
    const list = page.getByRole('listbox', { name: 'Files' });
    await expect(list).toContainText('example.ts');
    await composer(page).press('Enter');
    await expect(composer(page)).toHaveValue('read @src/example.ts ');
  });

  test('pasting an image attaches it and the image is sent with the prompt', async ({ page }) => {
    await composer(page).focus();
    await pasteImage(page, 'shot.png');
    await expect(page.locator('.attachments img[alt="shot.png"]')).toBeVisible();
    await composer(page).fill('what is in this picture');
    await composer(page).press('Enter');
    await expect(page.locator('.msg-user img.msg-img').first()).toBeVisible();
    await expect(page.locator('.msg-assistant').last()).toContainText('I can see 1 attached image.');
    await expectIdle(page);
  });

  test('an attachment can be removed before sending', async ({ page }) => {
    await pasteImage(page, 'drop.png');
    await expect(page.locator('.attachments img')).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove image' }).click();
    await expect(page.locator('.attachments img')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  test('Shift+Tab cycles the permission mode', async ({ page }) => {
    await sendPrompt(page, 'hello mode test');
    await expectIdle(page);
    await composer(page).focus();
    await expect(page.getByRole('button', { name: /Ask permissions/ })).toBeVisible();
    await composer(page).press('Shift+Tab');
    await expect(page.getByRole('button', { name: /Auto-accept edits/ })).toBeVisible();
    await composer(page).press('Shift+Tab');
    await expect(page.getByRole('button', { name: /Plan mode/ })).toBeVisible();
  });
});
