import { expect, test } from '@playwright/test'

test('local presentation: glass design, compact view menu, points and responsive layouts', async ({ page, baseURL }) => {
  test.skip(process.env.AUCTION_E2E_PRESENTATION !== '1',
    'Requires explicit opt-in to read-only presentation checks on a local server.')
  expect(['127.0.0.1', 'localhost']).toContain(new URL(baseURL!).hostname)
  const writes: string[] = []
  const remote: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url())
    if (new URL(request.url()).origin !== new URL(baseURL!).origin) remote.push(request.url())
  })
  await page.goto('/')
  await expect(page.locator('.team-card')).toHaveCount(5)
  await page.evaluate(async () => { await document.fonts.ready })
  const fonts = await page.evaluate(() => {
    const loaded: { family: string; status: FontFaceLoadStatus }[] = []
    document.fonts.forEach((font) => loaded.push({ family: font.family.replaceAll('"', ''), status: font.status }))
    return loaded
  })
  for (const family of ['Permanent Marker', 'Bebas Neue', 'Montserrat']) {
    expect(fonts).toContainEqual({ family, status: 'loaded' })
  }
  expect(await page.locator('.brand > span').evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Permanent Marker')
  expect(await page.locator('h2').first().evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Bebas Neue')
  expect(await page.locator('.app').evaluate((element) => getComputedStyle(element).getPropertyValue('--bg').trim())).toBe('#071024')
  expect(await page.locator('.app').evaluate((element) => getComputedStyle(element, '::before').backgroundImage)).toMatch(/serpent-glass|data:image\/svg/)
  expect(await page.locator('.team-card').first().evaluate((element) => getComputedStyle(element).backdropFilter)).toContain('blur')
  await expect(page.locator('.team-money > div').first().locator('strong')).toHaveText('1,000 points')
  expect(await page.locator('body').innerText()).not.toMatch(/\bCR\b|credits/i)
  for (const name of ['BlackMambas', 'Vipers']) {
    const image = page.locator('.team-card').filter({ hasText: name }).locator('.team-logo img')
    await image.scrollIntoViewIfNeeded()
    await expect(image).toHaveAttribute('src', `/api/branding/${name.toLowerCase()}-crest.jpg`)
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => [element.naturalWidth, element.naturalHeight])).toEqual([800, 800])
  }
  for (const width of [1920, 1440, 1024, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `No overflow at ${width}px`).toBeLessThanOrEqual(width)
    const crest = page.locator('.team-logo').first()
    const box = await crest.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(width <= 720 ? 80 : 88)
    const header = await page.locator('.site-header').boundingBox()
    const switchBox = await page.locator('.view-switch').boundingBox()
    expect(header!.height).toBeLessThanOrEqual(90)
    expect(switchBox!.width).toBeLessThan(150)
    if (width >= 1200) {
      const cards = await page.locator('.team-card').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))
      expect(new Set(cards).size, 'All five teams should fit one desktop row').toBe(1)
    }
    await expect(page.getByRole('link', { name: /Host sign in/ })).toHaveCount(0)
    await page.locator('.view-switch summary').click()
    await expect(page.getByRole('link', { name: /Host sign in/ })).toBeVisible()
    const menu = await page.locator('.view-switch nav').boundingBox()
    expect(menu!.x).toBeGreaterThanOrEqual(0)
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('link', { name: /Host sign in/ })).toHaveCount(0)
    await page.locator('.view-switch summary').click()
    await page.locator('.site-header').click({ position: { x: 4, y: 4 } })
    await expect(page.getByRole('link', { name: /Host sign in/ })).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'Switch to light theme' }).click()
  await expect(page.locator('.app')).toHaveClass(/light-theme/)
  expect(await page.locator('.app').evaluate((element) => getComputedStyle(element).getPropertyValue('--bg').trim())).toBe('#eef4ff')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()
  expect(writes).toEqual([])
  expect(remote).toEqual([])
})
