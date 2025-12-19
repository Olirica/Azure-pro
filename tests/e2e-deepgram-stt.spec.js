// @ts-check
const { test, expect } = require('@playwright/test')
const path = require('path')

const TEST_WAV = path.resolve(__dirname, 'Bilingual_1min.wav')
const BASE_URL = process.env.BASE_URL || 'http://localhost:8090'
const ROOM = 'dev'

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${TEST_WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
})

test.describe('Deepgram STT via browser', () => {
  test('streams audio to server-side STT and receives transcription', async ({ page }) => {
    // Navigate to speaker page
    await page.goto(`${BASE_URL}/speaker?room=${ROOM}`)

    // Wait for room unlock (dev room should auto-unlock)
    await expect(page.getByRole('heading', { name: 'Speaker' })).toBeVisible({ timeout: 10000 })

    // Select Deepgram provider if available
    const sttSelect = page.locator('select').filter({ hasText: /Deepgram|Azure/ })
    if (await sttSelect.isVisible()) {
      await sttSelect.selectOption('deepgram')
    }

    // Click start recording
    const startBtn = page.getByRole('button', { name: /Start Recording/i })
    await expect(startBtn).toBeVisible()
    await startBtn.click()

    // Wait for status to show listening
    await expect(page.getByText(/Listening/i)).toBeVisible({ timeout: 15000 })

    // Wait for transcription to appear (uses live transcription section)
    const transcriptSection = page.locator('h2:has-text("Live Transcription")')
    await expect(transcriptSection).toBeVisible({ timeout: 20000 })

    // Verify we got transcribed text
    const transcriptItems = page.locator('[class*="bg-white"][class*="rounded-xl"]').filter({ hasText: /.+/ })
    await expect(transcriptItems.first()).toBeVisible({ timeout: 10000 })
    const count = await transcriptItems.count()
    expect(count).toBeGreaterThan(0)

    // Stop recording
    const stopBtn = page.getByRole('button', { name: /Stop/i })
    await stopBtn.click()

    // Verify status returns to idle
    await expect(page.getByText(/Idle/i)).toBeVisible({ timeout: 5000 })
  })
})
