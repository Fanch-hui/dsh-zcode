import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectLocale, t } from '../src/i18n/index.js'

const KEYS = ['ZCODE_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANG'] as const

function withEnv(values: Partial<Record<(typeof KEYS)[number], string | undefined>>, run: () => void): void {
  const saved = KEYS.map(key => [key, process.env[key]] as const)
  for (const key of KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { run() } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('falls back to Chinese when no locale is configured', () => {
  withEnv({}, () => {
    assert.equal(detectLocale(), 'zh')
    assert.equal(t('settings.retry'), '重试')
  })
})

test('honours POSIX locale variables', () => {
  withEnv({ LANG: 'ru_RU.UTF-8' }, () => {
    assert.equal(detectLocale(), 'ru')
    assert.equal(t('settings.retry'), 'Повторить')
  })
  withEnv({ LC_ALL: 'en_US.UTF-8' }, () => {
    assert.equal(detectLocale(), 'en')
    assert.equal(t('settings.retry'), 'Retry')
  })
})

test('ZCODE_LOCALE overrides the environment', () => {
  withEnv({ ZCODE_LOCALE: 'en', LANG: 'ru_RU.UTF-8' }, () => {
    assert.equal(detectLocale(), 'en')
  })
  withEnv({ ZCODE_LOCALE: 'zh', LC_ALL: 'en_US.UTF-8' }, () => {
    assert.equal(detectLocale(), 'zh')
    assert.equal(t('cli.cancelled'), '操作已取消。')
  })
})

test('ignores unrecognized locales and interpolates parameters', () => {
  withEnv({ LANG: 'C.UTF-8' }, () => {
    assert.equal(detectLocale(), 'zh')
  })
  withEnv({ ZCODE_LOCALE: 'en' }, () => {
    assert.equal(t('http.detailCode', { code: '1302' }), ' (platform code 1302)')
    assert.equal(t('request.maxTokensRange', { max: 128000 }), 'The output limit must be an integer between 1 and 128000.')
  })
})
