import Check, {runThemeCheck} from './check.js'
import {describe, vi, expect, test, beforeEach} from 'vitest'
import {Config} from '@oclif/core'
import {
  themeCheckRun,
  Theme,
  Config as ThemeConfig,
  Offense,
  Severity,
  SourceCodeType,
  path as pathUtils,
} from '@shopify/theme-check-node'
import {joinPath} from '@shopify/cli-kit/node/path'

vi.mock('@shopify/theme-check-node')
const CommandConfig = new Config({root: __dirname})

describe('Check', () => {
  beforeEach(() => {
    // Mock process.exit
    vi.spyOn(process, 'exit').mockImplementation(() => {
      return undefined as never
    })

    // The whole module is auto-mocked above, so `path.fsPath` (used to compare
    // offense/source-code URIs against the requested file) needs a concrete
    // implementation for the filtering assertions to be meaningful.
    vi.mocked(pathUtils.fsPath).mockImplementation((uri) => (uri as string).replace(/^file:\/\//, ''))
  })

  describe('run', () => {
    const path = '/my-theme'

    async function run(argv: string[]) {
      await CommandConfig.load()
      const check = new Check([`--path=${path}`, ...argv], CommandConfig)

      await check.run()
    }

    test('should change config to "theme-check:recommended" when ":default" is inputted', async () => {
      const mockTheme: Theme = []
      const mockConfig: ThemeConfig = {
        context: 'theme',
        settings: {},
        checks: [],
        rootUri: '',
      }
      const mockOffenses: Offense[] = []

      vi.mocked(themeCheckRun).mockImplementation(async (path, config) => {
        expect(config).toBe('theme-check:recommended')
        return {offenses: mockOffenses, theme: mockTheme, config: mockConfig}
      })

      await run(['--config=:default'])
    })

    test('should change config to "theme-check:theme-app-extension" when ":theme_app_extensions" is inputted', async () => {
      const mockTheme: Theme = []
      const mockConfig: ThemeConfig = {
        context: 'app',
        settings: {},
        checks: [],
        rootUri: '',
      }
      const mockOffenses: Offense[] = []

      vi.mocked(themeCheckRun).mockImplementation(async (path, config) => {
        expect(config).toBe('theme-check:theme-app-extension')
        return {offenses: mockOffenses, theme: mockTheme, config: mockConfig}
      })

      await run(['--config=:theme_app_extensions'])
    })

    test('should not change config when ":theme_app_extension" is not inputted', async () => {
      const expectedConfig = 'some-config'
      const mockTheme: Theme = []
      const mockConfig: ThemeConfig = {
        context: 'theme',
        settings: {},
        checks: [],
        rootUri: '',
      }
      const mockOffenses: Offense[] = []

      vi.mocked(themeCheckRun).mockImplementation(async (path, config) => {
        expect(config).toBe(expectedConfig)
        return {offenses: mockOffenses, theme: mockTheme, config: mockConfig}
      })

      await run([`--config=${expectedConfig}`])
    })
  })

  describe('runThemeCheck with a target', () => {
    function offense(uri: string, check: string): Offense {
      return {
        type: SourceCodeType.LiquidHtml,
        check,
        message: 'Some message',
        uri,
        severity: Severity.WARNING,
        start: {index: 0, line: 0, character: 0},
        end: {index: 1, line: 0, character: 1},
      }
    }

    test('filters offenses and source codes down to a target file only', async () => {
      const targetFile = '/my-theme/sections/target.liquid'
      const targetOffense = offense(`file://${targetFile}`, 'TargetCheck')
      const otherOffense = offense('file:///my-theme/sections/other.liquid', 'OtherCheck')
      const mockTheme = [{uri: `file://${targetFile}`}, {uri: 'file:///my-theme/sections/other.liquid'}] as Theme

      vi.mocked(themeCheckRun).mockResolvedValue({
        offenses: [targetOffense, otherOffense],
        theme: mockTheme,
        config: {context: 'theme', settings: {}, checks: [], rootUri: ''},
      })

      const {offenses, theme} = await runThemeCheck('/my-theme', 'json', undefined, undefined, targetFile)

      expect(offenses).toEqual([targetOffense])
      expect(theme).toEqual([{uri: `file://${targetFile}`}])
    })

    test('filters offenses and source codes down to files within a target directory', async () => {
      const targetDir = '/my-theme/sections'
      const insideOffense = offense('file:///my-theme/sections/inside.liquid', 'InsideCheck')
      const outsideOffense = offense('file:///my-theme/snippets/outside.liquid', 'OutsideCheck')
      const mockTheme = [
        {uri: 'file:///my-theme/sections/inside.liquid'},
        {uri: 'file:///my-theme/snippets/outside.liquid'},
      ] as Theme

      vi.mocked(themeCheckRun).mockResolvedValue({
        offenses: [insideOffense, outsideOffense],
        theme: mockTheme,
        config: {context: 'theme', settings: {}, checks: [], rootUri: ''},
      })

      const {offenses, theme} = await runThemeCheck('/my-theme', 'json', undefined, undefined, targetDir)

      expect(offenses).toEqual([insideOffense])
      expect(theme).toEqual([{uri: 'file:///my-theme/sections/inside.liquid'}])
    })

    test('returns every offense and source code when no target is provided', async () => {
      const targetOffense = offense('file:///my-theme/sections/target.liquid', 'TargetCheck')
      const otherOffense = offense('file:///my-theme/sections/other.liquid', 'OtherCheck')
      const mockTheme = [
        {uri: 'file:///my-theme/sections/target.liquid'},
        {uri: 'file:///my-theme/sections/other.liquid'},
      ] as Theme

      vi.mocked(themeCheckRun).mockResolvedValue({
        offenses: [targetOffense, otherOffense],
        theme: mockTheme,
        config: {context: 'theme', settings: {}, checks: [], rootUri: ''},
      })

      const {offenses, theme} = await runThemeCheck('/my-theme', 'json')

      expect(offenses).toEqual([targetOffense, otherOffense])
      expect(theme).toEqual(mockTheme)
    })
  })

  describe('run with --path and a target argument', () => {
    const themeRoot = joinPath(__dirname, '../../utilities/fixtures/theme')
    const fixtureFile = joinPath(themeRoot, 'sections/announcement-bar.liquid')

    test('resolves the target relative to --path and checks the same root, filtering to that target', async () => {
      const targetOffense: Offense = {
        type: SourceCodeType.LiquidHtml,
        check: 'SomeCheck',
        message: 'Some message',
        uri: `file://${fixtureFile}`,
        severity: Severity.WARNING,
        start: {index: 0, line: 0, character: 0},
        end: {index: 1, line: 0, character: 1},
      }

      vi.mocked(themeCheckRun).mockImplementation(async (root) => {
        expect(root).toBe(themeRoot)
        return {
          offenses: [targetOffense],
          theme: [{uri: `file://${fixtureFile}`}] as Theme,
          config: {context: 'theme', settings: {}, checks: [], rootUri: ''},
        }
      })

      await CommandConfig.load()
      const check = new Check([`--path=${themeRoot}`, 'sections/announcement-bar.liquid'], CommandConfig)
      await check.run()

      expect(themeCheckRun).toHaveBeenCalledWith(themeRoot, undefined, expect.any(Function))
    })

    test('resolves a target directory relative to --path without an extension check', async () => {
      vi.mocked(themeCheckRun).mockImplementation(async (root) => {
        expect(root).toBe(themeRoot)
        return {offenses: [], theme: [], config: {context: 'theme', settings: {}, checks: [], rootUri: ''}}
      })

      await CommandConfig.load()
      const check = new Check([`--path=${themeRoot}`, 'sections'], CommandConfig)
      await check.run()

      expect(themeCheckRun).toHaveBeenCalledWith(themeRoot, undefined, expect.any(Function))
    })

    test('rejects a target that is not a .liquid or .json file', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit')
      })

      await CommandConfig.load()
      const check = new Check([`--path=${themeRoot}`, 'assets/base.css'], CommandConfig)

      await expect(check.run()).rejects.toThrow('exit')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(themeCheckRun).not.toHaveBeenCalled()
    })

    test('rejects a target that does not exist', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit')
      })

      await CommandConfig.load()
      const check = new Check([`--path=${themeRoot}`, 'sections/does-not-exist.liquid'], CommandConfig)

      await expect(check.run()).rejects.toThrow('exit')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(themeCheckRun).not.toHaveBeenCalled()
    })
  })
})
