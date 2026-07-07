import ThemeCommand, {RequiredFlags} from '../../utilities/theme-command.js'
import {
  formatOffensesJson,
  formatSummary,
  initConfig,
  outputActiveChecks,
  outputActiveConfig,
  performAutoFixes,
  renderOffensesText,
  sortOffenses,
  isExtendedWriteStream,
  handleExit,
  type FailLevel,
} from '../../services/check.js'
import {themeFlags} from '../../flags.js'
import {Args, Flags} from '@oclif/core'
import {globalFlags} from '@shopify/cli-kit/node/cli'
import {outputResult, outputDebug} from '@shopify/cli-kit/node/output'
import {renderError, renderInfo, renderSuccess} from '@shopify/cli-kit/node/ui'
import {
  themeCheckRun,
  LegacyIdentifiers,
  findRoot,
  makeFileExists,
  NodeFileSystem,
  path as pathUtils,
} from '@shopify/theme-check-node'
import {findPathUp, fileExistsSync, isDirectorySync} from '@shopify/cli-kit/node/fs'
import {moduleDirectory, joinPath, resolvePath} from '@shopify/cli-kit/node/path'
import {getPackageVersion} from '@shopify/cli-kit/node/node-package-manager'
import {InferredArgs, InferredFlags} from '@oclif/core/interfaces'
import {AdminSession} from '@shopify/cli-kit/node/session'

type CheckFlags = InferredFlags<typeof Check.flags>
type CheckArgs = InferredArgs<typeof Check.args>
export default class Check extends ThemeCommand {
  static summary = 'Validate the theme.'

  static descriptionWithMarkdown = `Calls and runs [Theme Check](https://shopify.dev/docs/themes/tools/theme-check) to analyze your theme code for errors and to ensure that it follows theme and Liquid best practices. [Learn more about the checks that Theme Check runs.](https://shopify.dev/docs/themes/tools/theme-check/checks) Pass a path to a single \`.liquid\` or \`.json\` theme file to check only that file.`

  static description = this.descriptionWithoutMarkdown()

  static usage = 'theme check [path] [flags]'

  static args = {
    path: Args.string({
      name: 'path',
      description: 'Path to a theme file or directory to check. Defaults to checking the whole theme (see --path).',
      required: false,
    }),
  }

  static flags = {
    ...globalFlags,
    path: themeFlags.path,
    'auto-correct': Flags.boolean({
      char: 'a',
      required: false,
      description: 'Automatically fix offenses',
      env: 'SHOPIFY_FLAG_AUTO_CORRECT',
    }),
    config: Flags.string({
      char: 'C',
      required: false,
      description: `Use the config provided, overriding .theme-check.yml if present
      Supports all theme-check: config values, e.g., theme-check:theme-app-extension,
      theme-check:recommended, theme-check:all
      For backwards compatibility, :theme_app_extension is also supported `,
      env: 'SHOPIFY_FLAG_CONFIG',
    }),
    'fail-level': Flags.string({
      required: false,
      description: 'Minimum severity for exit with error code',
      env: 'SHOPIFY_FLAG_FAIL_LEVEL',
      options: ['crash', 'error', 'suggestion', 'style', 'warning', 'info'],
      default: 'error',
    }),
    init: Flags.boolean({
      required: false,
      description: 'Generate a .theme-check.yml file',
      env: 'SHOPIFY_FLAG_INIT',
    }),
    list: Flags.boolean({
      required: false,
      description: 'List enabled checks',
      env: 'SHOPIFY_FLAG_LIST',
    }),
    output: Flags.string({
      char: 'o',
      required: false,
      description: 'The output format to use',
      env: 'SHOPIFY_FLAG_OUTPUT',
      options: ['text', 'json'],
      default: 'text',
    }),
    print: Flags.boolean({
      required: false,
      description: 'Output active config to STDOUT',
      env: 'SHOPIFY_FLAG_PRINT',
    }),
    version: Flags.boolean({
      char: 'v',
      required: false,
      description: 'Print Theme Check version',
      env: 'SHOPIFY_FLAG_VERSION',
    }),
    environment: themeFlags.environment,
  }

  static multiEnvironmentsFlags: RequiredFlags = ['path']

  async command(flags: CheckFlags, _session: AdminSession, multiEnvironment: boolean, args: CheckArgs): Promise<void> {
    // Its not clear to typescript that path will always be defined
    const inputPath = args.path ? resolveArgPath(args.path) : flags.path
    const environment = flags.environment?.[0]
    // To support backwards compatibility for legacy configs
    const isLegacyConfig = flags.config?.startsWith(':') && LegacyIdentifiers.has(flags.config.slice(1))

    const config = isLegacyConfig ? LegacyIdentifiers.get(flags.config!.slice(1)) : flags.config

    // A single theme file can be provided instead of a directory. When that
    // happens, we still need the theme's root directory to build full theme
    // context (e.g. cross-file checks), so we resolve it and only report
    // offenses for the given file.
    const targetFile = inputPath && !isDirectorySync(inputPath) ? inputPath : undefined

    if (targetFile && !/\.(?:liquid|json)$/.test(targetFile)) {
      renderError({
        headline: 'Theme Check only supports .liquid and .json files.',
        body: [`Please check the path and try again: ${targetFile}`],
      })
      return process.exit(1)
    }

    const path = targetFile ? await resolveThemeRootForFile(targetFile) : inputPath

    if (flags.init) {
      await initConfig(path)

      // --init should not trigger full theme check operation
      return
    }

    if (flags.version) {
      const pkgJsonPath = await findPathUp(joinPath('node_modules', '@shopify', 'theme-check-node', 'package.json'), {
        type: 'file',
        cwd: moduleDirectory(import.meta.url),
      })

      let version = 'unknown'
      if (pkgJsonPath) {
        version = (await getPackageVersion(pkgJsonPath)) ?? 'unknown'
      }

      outputResult(version)

      // --version should not trigger full theme check operation
      return
    }

    if (flags.print) {
      await outputActiveConfig(path, config, environment)

      // --print should not trigger full theme check operation
      return
    }

    if (flags.list) {
      await outputActiveChecks(path, config, environment)

      // --list should not trigger full theme check operation
      return
    }

    const {offenses, theme} = await runThemeCheck(path, flags.output, config, environment, targetFile)

    if (flags['auto-correct']) {
      await performAutoFixes(theme, offenses)
    }

    if (!multiEnvironment) {
      return handleExit(offenses, flags['fail-level'] as FailLevel)
    }
  }
}

function resolveArgPath(input: string): string {
  const resolvedPath = resolvePath(input)

  if (!fileExistsSync(resolvedPath)) {
    renderError({
      headline: "A path was explicitly provided but doesn't exist.",
      body: [`Please check the path and try again: ${resolvedPath}`],
    })
    return process.exit(1)
  }

  return resolvedPath
}

/**
 * Finds the theme root for a single theme file by walking up parent
 * directories looking for a `.theme-check.yml`, `.git`, or the theme
 * directory structure (`assets` + `snippets`), mirroring theme-check's own
 * root inference so that cross-file checks still have full theme context.
 */
async function resolveThemeRootForFile(filePath: string): Promise<string> {
  const fileUri = pathUtils.normalize(pathUtils.URI.file(filePath))
  const rootUri = await findRoot(pathUtils.dirname(fileUri), makeFileExists(NodeFileSystem))

  if (!rootUri) {
    renderError({
      headline: "Couldn't determine the theme root for the given file.",
      body: [`Please check the path and try again: ${filePath}`],
    })
    return process.exit(1)
  }

  return pathUtils.fsPath(rootUri)
}

export async function runThemeCheck(
  path: string,
  outputFormat: string,
  config?: string,
  environment?: string,
  targetFile?: string,
) {
  const {offenses: allOffenses, theme: allSourceCodes} = await themeCheckRun(path, config, (message) => {
    if (process.env.SHOPIFY_TMP_FLAG_DEBUG) {
      outputDebug(message)
    }
  })

  const offenses = targetFile
    ? allOffenses.filter((offense) => pathUtils.fsPath(offense.uri) === targetFile)
    : allOffenses
  const theme = targetFile
    ? allSourceCodes.filter((sourceCode) => pathUtils.fsPath(sourceCode.uri) === targetFile)
    : allSourceCodes

  const offensesByFile = sortOffenses(offenses)

  if (outputFormat === 'text') {
    renderOffensesText(offensesByFile, path, environment)

    // Use renderSuccess when theres no offenses
    const render = offenses.length ? renderInfo : renderSuccess

    render({
      headline: environment ? `[${environment}] Theme Check Summary.` : 'Theme Check Summary.',
      body: formatSummary(offenses, offensesByFile, theme),
    })
  }

  if (outputFormat === 'json') {
    /**
     * Workaround:
     * Force stdout to be blocking so that the JSON output is not broken when piped to another process.
     * ie: ` | jq .`
     * It turns out that console.log is technically asynchronous, and when we call process.exit(),
     * node doesn't wait on all the output being sent to stdout and instead closes the process immediately
     *
     * https://github.com/pnp/cli-microsoft365/issues/1266#issuecomment-727254264
     *
     */
    const stdout = process.stdout
    if (isExtendedWriteStream(stdout)) {
      stdout._handle.setBlocking(true)
    }

    outputResult(JSON.stringify(formatOffensesJson(offensesByFile, environment)))
  }

  return {offenses, theme}
}
