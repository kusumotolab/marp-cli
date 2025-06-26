import fs from 'node:fs'
import path from 'node:path'
import chalk from 'chalk'
import { cosmiconfig, cosmiconfigSync } from 'cosmiconfig'
import { osLocale } from 'os-locale'
import { availableFinders } from './browser/finder'
import type { FinderName } from './browser/finder'
import type { BrowserManagerConfig } from './browser/manager'
import { info, warn, error as cliError } from './cli'
import { ConvertType, type ConverterOption } from './converter'
import { ResolvableEngine, ResolvedEngine } from './engine'
import { keywordsAsArray } from './engine/meta-plugin'
import { error, isError } from './error'
import { TemplateOption } from './templates'
import { Theme, ThemeSet } from './theme'
import { isStandaloneBinary } from './utils/binary'
import { isOfficialContainerImage } from './utils/container'
import { debugConfig } from './utils/debug'

type Overwrite<T, U> = Omit<T, Extract<keyof T, keyof U>> & U

interface IMarpCLIArguments {
  _?: string[]
  allowLocalFiles?: boolean
  author?: string
  baseUrl?: string
  'bespoke.osc'?: boolean
  'bespoke.progress'?: boolean
  'bespoke.transition'?: boolean
  browser?: string | string[]
  browserPath?: string
  browserProtocol?: string
  browserTimeout?: number
  configFile?: string | false
  description?: string
  engine?: string
  html?: boolean
  image?: string
  images?: string
  imageScale?: number
  inputDir?: string
  jpegQuality?: number
  keywords?: string
  notes?: boolean
  ogImage?: string
  output?: string | false
  parallel?: number | boolean
  pdf?: boolean
  pdfNotes?: boolean
  pdfOutlines?: boolean
  'pdfOutlines.pages'?: boolean
  'pdfOutlines.headings'?: boolean
  pptx?: boolean
  pptxEditable?: boolean
  preview?: boolean
  server?: boolean
  template?: string
  theme?: string
  themeSet?: string[]
  title?: string
  url?: string
  watch?: boolean
  cleanUrls?: boolean
}

export type IMarpCLIConfig = Overwrite<
  Omit<
    IMarpCLIArguments,
    | '_'
    | 'configFile'
    | 'bespoke.osc'
    | 'bespoke.progress'
    | 'bespoke.transition'
    | 'pdfOutlines'
    | 'pdfOutlines.pages'
    | 'pdfOutlines.headings'
  >,
  {
    bespoke?: {
      osc?: boolean
      progress?: boolean
      transition?: boolean
    }
    browser?: 'auto' | FinderName | FinderName[]
    browserProtocol?: 'cdp' | 'webdriver-bidi'
    engine?: ResolvableEngine
    html?: ConverterOption['html']
    keywords?: string | string[]
    lang?: string
    options?: ConverterOption['options']
    pdfOutlines?:
      | boolean
      | {
          pages?: boolean
          headings?: boolean
        }
    themeSet?: string | string[]
    cleanUrls?: boolean
  }
>

export const DEFAULT_PARALLEL = 5

export class MarpCLIConfig {
  args: IMarpCLIArguments = {}
  conf: IMarpCLIConfig = {}
  confPath?: string
  engine!: ResolvedEngine

  static moduleName = 'marp' as const

  static async fromArguments(args: IMarpCLIArguments) {
    const conf = new MarpCLIConfig()

    debugConfig('Passed arguments: %o', args)
    conf.args = args

    if (args.configFile !== false) await conf.loadConf(args.configFile)

    conf.engine = await (() => {
      if (conf.args.engine) return ResolvedEngine.resolve(conf.args.engine)
      if (conf.conf.engine)
        return ResolvedEngine.resolve(conf.conf.engine, conf.confPath)

      return ResolvedEngine.resolveDefaultEngine()
    })()

    return conf
  }

  static isESMAvailable() {
    return ResolvedEngine.isESMAvailable()
  }

  private constructor() {} // eslint-disable-line @typescript-eslint/no-empty-function

  browserManagerOption() {
    const finders = (() => {
      const isAvailableFinder = (f: string): f is FinderName =>
        (availableFinders as string[]).includes(f)

      const browser = this.args.browser ?? this.conf.browser ?? 'auto'

      if (typeof browser === 'string') {
        const normalized = browser.toLowerCase()

        if (normalized === 'auto') return undefined
        if (isAvailableFinder(normalized)) return normalized

        error(`Unknown browser: ${browser}`)
      }

      const filtered = browser.filter(isAvailableFinder)

      if (filtered.length === 0 && browser.length > 0)
        error(`No available browsers: ${browser.join(', ')}`)

      return filtered
    })()

    const browserPath = (() => {
      if (this.args.browserPath) return path.resolve(this.args.browserPath)
      if (this.conf.browserPath)
        return path.resolve(path.dirname(this.confPath!), this.conf.browserPath)

      // Replacement for CHROME_PATH environment variable
      if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH

      return undefined
    })()

    const protocol = (() => {
      const target =
        this.args.browserProtocol ?? this.conf.browserProtocol ?? 'cdp'

      if (target === 'cdp') return 'cdp'
      if (target === 'webdriver-bidi') return 'webDriverBiDi'

      error(`Unknown browser protocol: ${target}`)
    })()

    const timeout = (() => {
      if (this.args.browserTimeout !== undefined)
        return Math.floor(this.args.browserTimeout * 1000)

      if (this.conf.browserTimeout !== undefined)
        return Math.floor(this.conf.browserTimeout * 1000)

      // Fallback to classic way until v3 (PUPPETEER_TIMEOUT environment variable)
      if (process.env.PUPPETEER_TIMEOUT) {
        const envTimeout = Number.parseInt(process.env.PUPPETEER_TIMEOUT, 10)
        if (!Number.isNaN(envTimeout)) return envTimeout
      }
      return undefined
    })()

    return {
      finders,
      path: browserPath,
      protocol,
      timeout,
    } as const satisfies BrowserManagerConfig
  }

  async converterOption() {
    const inputDir = await this.inputDir()
    const server = this.args.server ?? this.conf.server ?? false
    const output = (() => {
      if (server) return false
      if (this.args.output !== undefined) return this.args.output
      if (this.conf.output !== undefined)
        return this.conf.output === '-' || this.conf.output === false
          ? this.conf.output
          : path.resolve(path.dirname(this.confPath!), this.conf.output)

      return undefined
    })()

    const preview = (() => {
      const p = this.args.preview ?? this.conf.preview ?? false

      if (p && isOfficialContainerImage()) {
        warn(
          `Preview window cannot show within an official docker image. Preview option was ignored.`
        )
        return false
      }

      return p
    })()

    const template = this.args.template || this.conf.template || 'bespoke'
    const templateOption: TemplateOption = (() => {
      if (template === 'bespoke') {
        const bespoke = this.conf.bespoke || {}

        return {
          osc: this.args['bespoke.osc'] ?? bespoke.osc,
          progress: this.args['bespoke.progress'] ?? bespoke.progress,
          transition: this.args['bespoke.transition'] ?? bespoke.transition,
        }
      }
      return {}
    })()

    const theme = await this.loadTheme()
    const initialThemes = theme instanceof Theme ? [theme] : []

    const themeSetPaths =
      this.args.themeSet ||
      (this.conf.themeSet
        ? (Array.isArray(this.conf.themeSet)
            ? this.conf.themeSet
            : [this.conf.themeSet]
          ).map((f) => path.resolve(path.dirname(this.confPath!), f))
        : [])

    const themeSet = await ThemeSet.initialize(
      (inputDir ? [inputDir] : []).concat(themeSetPaths),
      initialThemes
    )

    if (
      themeSet.themes.size <= initialThemes.length &&
      themeSetPaths.length > 0
    )
      warn('Not found additional theme CSS files.')

    const pdfNotes = !!(this.args.pdfNotes || this.conf.pdfNotes)
    const pdfOutlines =
      (this.args.pdfOutlines ?? this.conf.pdfOutlines)
        ? (() => {
            const defaultPdfOutlines = { pages: true, headings: true } as const
            const getConf = (key: keyof typeof defaultPdfOutlines) => {
              const argOption = this.args[`pdfOutlines.${key}`]
              if (argOption !== undefined) return argOption
              if (typeof this.conf.pdfOutlines === 'object')
                return !!this.conf.pdfOutlines[key]

              return defaultPdfOutlines[key]
            }

            const pages = getConf('pages')
            const headings = getConf('headings')

            if (!pages && !headings) return false
            return { pages, headings }
          })()
        : false

    const pptxEditable = !!(this.args.pptxEditable || this.conf.pptxEditable)

    const type = ((): ConvertType => {
      // CLI options
      if (this.args.pdf || this.conf.pdf) return ConvertType.pdf
      if (this.args.pptx || this.conf.pptx) return ConvertType.pptx
      if (this.args.notes || this.conf.notes) return ConvertType.notes

      const image =
        this.args.images ||
        this.conf.images ||
        this.args.image ||
        this.conf.image

      if (image === 'png') return ConvertType.png
      if (image === 'jpg' || image === 'jpeg') return ConvertType.jpeg

      // Detect from filename
      const lowerOutput = (output || '').toLowerCase()
      if (lowerOutput.endsWith('.html') || lowerOutput.endsWith('.htm'))
        return ConvertType.html
      if (lowerOutput.endsWith('.pdf')) return ConvertType.pdf
      if (lowerOutput.endsWith('.png')) return ConvertType.png
      if (lowerOutput.endsWith('.pptx')) return ConvertType.pptx
      if (lowerOutput.endsWith('.jpg') || lowerOutput.endsWith('.jpeg'))
        return ConvertType.jpeg
      if (lowerOutput.endsWith('.txt')) return ConvertType.notes

      // Prefer PDF than HTML if enabled any PDF options
      if ((this.args.pdf ?? this.conf.pdf) !== false) {
        if (pdfNotes || pdfOutlines) return ConvertType.pdf
      }

      // Prefer PPTX than HTML if enabled PPTX option
      if ((this.args.pptx ?? this.conf.pptx) !== false) {
        if (pptxEditable) return ConvertType.pptx
      }

      return ConvertType.html
    })()

    const imageScale = (() => {
      const scale = this.args.imageScale ?? this.conf.imageScale

      if (scale !== undefined) {
        if (typeof scale !== 'number') {
          error('Image scale factor must be a number.')
        }
        if (scale <= 0) error('Image scale factor cannot set as 0 or less.')
        if (scale > 10) {
          warn(
            `You are setting too large image scale factor (x${scale}). Automatically restricted to x10.`
          )
          return 10
        }
      }

      return scale
    })()

    const parallel = (() => {
      const parseParallel = (value: boolean | number | undefined) => {
        if (value === true) return DEFAULT_PARALLEL
        if (value === false) return 1
        if (typeof value === 'number') return Math.max(1, value)

        return undefined
      }

      return (
        parseParallel(this.args.parallel) ??
        parseParallel(this.conf.parallel) ??
        DEFAULT_PARALLEL
      )
    })()

    return {
      imageScale,
      inputDir,
      output,
      parallel,
      pdfNotes,
      pdfOutlines,
      pptxEditable,
      preview,
      server,
      template,
      templateOption,
      themeSet,
      type,
      allowLocalFiles:
        this.args.allowLocalFiles ?? this.conf.allowLocalFiles ?? false,
      baseUrl: this.args.baseUrl ?? this.conf.baseUrl,
      engine: this.engine.klass,
      globalDirectives: {
        author: this.args.author ?? this.conf.author,
        description: this.args.description ?? this.conf.description,
        image: this.args.ogImage ?? this.conf.ogImage,
        keywords: keywordsAsArray(this.args.keywords ?? this.conf.keywords),
        theme: theme instanceof Theme ? theme.name : theme,
        title: this.args.title ?? this.conf.title,
        url: this.args.url ?? this.conf.url,
      },
      html: this.args.html ?? this.conf.html,
      jpegQuality: this.args.jpegQuality ?? this.conf.jpegQuality ?? 85,
      lang: this.conf.lang || (await osLocale()).replace(/@/g, '-'),
      options: this.conf.options || {},
      pages: !!(this.args.images || this.conf.images),
      watch: (this.args.watch ?? this.conf.watch) || preview || server || false,
      cleanUrls: this.args.cleanUrls ?? this.conf.cleanUrls ?? false,
    } as const satisfies Partial<ConverterOption>
  }

  get files() {
    return this.args.server || this.conf.server ? [] : this.args._ || []
  }

  private async inputDir(): Promise<string | undefined> {
    const dir = (() => {
      if (this.args.inputDir) return path.resolve(this.args.inputDir)
      if (this.conf.inputDir)
        return path.resolve(path.dirname(this.confPath!), this.conf.inputDir)

      // Fallback to input arguments in server mode
      if (this.args.server || this.conf.server) {
        if (Array.isArray(this.args._)) {
          if (this.args._.length > 1) {
            error('Server mode have to specify just one directory.')
          }
          if (this.args._.length === 1) return path.resolve(this.args._[0])
        }
      }
    })()
    if (dir === undefined) return undefined

    let stat: fs.Stats

    try {
      stat = await fs.promises.lstat(dir)
    } catch (e: unknown) {
      if (isError(e) && e.code !== 'ENOENT') throw e
      error(`Input directory "${dir}" is not found.`)
    }

    if (!stat.isDirectory()) error(`"${dir}" is not directory.`)

    return dir
  }

  private async loadConf(confPath?: string) {
    const explorer = MarpCLIConfig.isESMAvailable()
      ? cosmiconfig(MarpCLIConfig.moduleName)
      : cosmiconfigSync(MarpCLIConfig.moduleName)

    try {
      const ret = await (async () => {
        if (confPath !== undefined) {
          debugConfig(
            'Loading configuration file from specified path: %s',
            confPath
          )
          return explorer.load(confPath)
        }

        const currentDir = process.cwd()
        debugConfig(
          'Finding configuration file from current directory: %s',
          currentDir
        )

        return explorer.search(currentDir)
      })()

      if (ret && !ret.isEmpty) {
        debugConfig('Loaded configuration file: %s', ret.filepath)
      } else {
        debugConfig('No configuration file found.')
      }

      if (ret) {
        this.confPath = ret.filepath
        this.conf = ret.config
      }
    } catch (e: unknown) {
      debugConfig('Error occurred during loading configuration file: %o', e)

      const isErr = isError(e)

      if (isErr && e.code === 'ERR_REQUIRE_ESM') {
        // Show reason why `require()` failed in the current context
        if (isStandaloneBinary()) {
          cliError(
            'A standalone binary version of Marp CLI is currently not supported resolving ESM. Please consider using CommonJS, or trying to use Marp CLI via Node.js.'
          )
        }
      }

      error(
        [
          'Could not find or parse configuration file.',
          isErr && `(${e.name}: ${e.message.trimEnd()})`,
          confPath !== undefined && `[${confPath}]`,
        ]
          .filter((m) => m)
          .join(' ')
      )
    }
  }

  private async loadTheme(): Promise<string | Theme | undefined> {
    const theme = (() => {
      if (this.args.theme)
        return {
          advice: { use: '--theme-set', insteadOf: '--theme' },
          name: this.args.theme,
          path: path.resolve(this.args.theme),
        }

      if (this.conf.theme)
        return {
          advice: { use: 'themeSet', insteadOf: 'theme' },
          name: this.conf.theme,
          path: path.resolve(path.dirname(this.confPath!), this.conf.theme),
        }
    })()
    if (!theme) return undefined

    try {
      return await Theme.initialize(theme.path, { overrideName: true })
    } catch (e: unknown) {
      if (isError(e)) {
        if (e.code === 'EISDIR') {
          info(
            `Please use ${chalk.yellow(theme.advice.use)} option instead of ${
              theme.advice.insteadOf
            } to make theme CSS available from directory.`
          )
          error(`Directory cannot pass to theme option. (${theme.path})`)
        }
        if (e.code !== 'ENOENT') throw e
      } else {
        throw e
      }
    }

    return theme.name
  }
}

export const { fromArguments } = MarpCLIConfig
