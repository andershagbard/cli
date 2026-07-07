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
import {themeCheckRun, LegacyIdentifiers, path as pathUtils} from '@shopify/theme-check-node'
import {findPathUp, fileExistsSync, isDirectorySync, matchGlob} from '@shopify/cli-kit/node/fs'
import {moduleDirectory, joinPath, resolvePath, relativePath, isAbsolutePath} from '@shopify/cli-kit/node/path'
import {getPackageVersion} from '@shopify/cli-kit/node/node-package-manager'
import {InferredArgs, InferredFlags} from '@oclif/core/interfaces'
import {AdminSession} from '@shopify/cli-kit/node/session'

type CheckFlags = InferredFlags<typeof Check.flags>
type CheckArgs = InferredArgs<typeof Check.args>
export default class Check extends ThemeCommand {
  static summary = 'Validate the theme.'

  static descriptionWithMarkdown = `Calls and runs [Theme Check](https://shopify.dev/docs/themes/tools/theme-check) to analyze your theme code for errors and to ensure that it follows theme and Liquid best practices. [Learn more about the checks that Theme Check runs.](https://shopify.dev/docs/themes/tools/theme-check/checks)`

  static description = this.descriptionWithoutMarkdown()

  static args = {
    target: Args.string({
      name: 'target',
      description:
        'A theme file, directory, or glob pattern to check, relative to --path (e.g. "sections/*.liquid"). When provided, only offenses matching it are reported.',
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
    const path = flags.path
    const environment = flags.environment?.[0]
    // To support backwards compatibility for legacy configs
    const isLegacyConfig = flags.config?.startsWith(':') && LegacyIdentifiers.has(flags.config.slice(1))

    const config = isLegacyConfig ? LegacyIdentifiers.get(flags.config!.slice(1)) : flags.config

    // The target argument builds on top of --path: it can narrow the check
    // down to a single file, a subdirectory, or a glob pattern within the
    // theme rooted at --path.
    const isTargetGlob = args.target ? isGlobPattern(args.target) : false
    const target = args.target ? resolveTarget(path, args.target, isTargetGlob) : undefined

    if (target && !isTargetGlob && !isDirectorySync(target) && !/\.(?:liquid|json)$/.test(target)) {
      renderError({
        headline: 'Theme Check only supports .liquid and .json files.',
        body: [`Please check the path and try again: ${target}`],
      })
      return process.exit(1)
    }

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

    const {offenses, theme} = await runThemeCheck(path, flags.output, config, environment, target, isTargetGlob)

    if (flags['auto-correct']) {
      await performAutoFixes(theme, offenses)
    }

    if (!multiEnvironment) {
      return handleExit(offenses, flags['fail-level'] as FailLevel)
    }
  }
}

const GLOB_METACHARACTERS = /[*?{}[\]]/

/**
 * Whether a target argument should be treated as a glob pattern rather than
 * a literal file or directory path.
 */
function isGlobPattern(target: string): boolean {
  return GLOB_METACHARACTERS.test(target)
}

/**
 * Resolves the `target` argument against the theme root (--path). Absolute
 * targets are used as-is; relative ones are resolved on top of the root.
 * Glob patterns aren't checked for existence, since they describe a set of
 * files rather than a single path.
 */
function resolveTarget(root: string, target: string, isGlob: boolean): string {
  const resolvedTarget = resolvePath(root, target)

  if (isGlob) {
    return resolvedTarget
  }

  if (!fileExistsSync(resolvedTarget)) {
    renderError({
      headline: "A path was explicitly provided but doesn't exist.",
      body: [`Please check the path and try again: ${resolvedTarget}`],
    })
    return process.exit(1)
  }

  return resolvedTarget
}

/**
 * Whether a theme file's fs path is the target itself, or lives underneath
 * it when the target is a directory.
 */
function isWithinTarget(filePath: string, target: string): boolean {
  if (filePath === target) return true

  const relative = relativePath(target, filePath)
  return relative !== '' && !relative.startsWith('..') && !isAbsolutePath(relative)
}

/**
 * minimatch (used by matchGlob) expects forward slashes on all platforms.
 */
function toGlobPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function matchesTarget(filePath: string, target: string, isTargetGlob: boolean): boolean {
  if (isTargetGlob) {
    return matchGlob(toGlobPath(filePath), toGlobPath(target))
  }

  return isWithinTarget(filePath, target)
}

export async function runThemeCheck(
  path: string,
  outputFormat: string,
  config?: string,
  environment?: string,
  target?: string,
  isTargetGlob = false,
) {
  const {offenses: allOffenses, theme: allSourceCodes} = await themeCheckRun(path, config, (message) => {
    if (process.env.SHOPIFY_TMP_FLAG_DEBUG) {
      outputDebug(message)
    }
  })

  const offenses = target
    ? allOffenses.filter((offense) => matchesTarget(pathUtils.fsPath(offense.uri), target, isTargetGlob))
    : allOffenses
  const theme = target
    ? allSourceCodes.filter((sourceCode) => matchesTarget(pathUtils.fsPath(sourceCode.uri), target, isTargetGlob))
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
