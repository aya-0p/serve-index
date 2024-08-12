/*!
 * serve-index
 * Copyright(c) 2011 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */

import accepts from "accepts";
import createError from "http-errors";
import debug_ from "debug";
const debug = debug_("serve-index");
import escapeHtml from "escape-html";
import fs from "node:fs";
import { normalize, sep, extname, join, resolve } from "node:path";
import Batch from "batch";
import mime from "mime-types"
import parseUrl from "parseurl";
import { IncomingMessage, ServerResponse } from "node:http";

/*!
 * Icon cache.
 */

const cache: {[iconName: string]: string} = {};

/*!
 * Default template.
 */

const defaultTemplate = join(__dirname, 'public', 'directory.html');

/*!
 * Stylesheet.
 */

const defaultStylesheet = join(__dirname, 'public', 'style.css');

/**
 * Media types and the map for content negotiation.
 */

const mediaTypes = [
  'text/html',
  'text/plain',
  'application/json'
];

const mediaType = {
  'text/html': 'html',
  'text/plain': 'plain',
  'application/json': 'json'
} as const;

/**
 * Serve directory listings with the given `root` path.
 *
 * See Readme.md for documentation of options.
 *
 * @public
 */

export function serveIndex(root: string, options?: ServeIndexOptions): (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void {
  const opts = options || {};

  // root required
  if (!root) {
    throw new TypeError('serveIndex() root path required');
  }

  // resolve root to absolute and normalize
  const rootPath = normalize(resolve(root) + sep);

  const filter = opts.filter;
  const hidden = opts.hidden;
  const icons = opts.icons;
  const stylesheet = opts.stylesheet || defaultStylesheet;
  const template = opts.template || defaultTemplate;
  const view = opts.view || 'tiles';

  return function (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 'OPTIONS' === req.method ? 200 : 405;
      res.setHeader('Allow', 'GET, HEAD, OPTIONS');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }

    // get dir
    const dir = getRequestedDir(req)

    // bad request
    if (dir === null) return next(createError(400))

    // parse URLs
    const originalUrl = parseUrl.original(req);
    const originalDir = decodeURIComponent(originalUrl?.pathname ?? "");

    // join / normalize from root dir
    const path = normalize(join(rootPath, dir));

    // null byte(s), bad request
    if (~path.indexOf('\0')) return next(createError(400));

    // malicious path
    if ((path + sep).substr(0, rootPath.length) !== rootPath) {
      debug('malicious path "%s"', path);
      return next(createError(403));
    }

    // determine ".." display
    const showUp = normalize(resolve(path) + sep) !== rootPath;

    // check if we have a directory
    debug('stat "%s"', path);
    fs.stat(path, function(err, stat){
      if (err && err.code === 'ENOENT') {
        return next();
      }

      if (err) {
        const error: typeof err & { status?: number } = err;
        error.status = err.code === 'ENAMETOOLONG'
          ? 414
          : 500;
        return next(error);
      }

      if (!stat.isDirectory()) return next();

      // fetch files
      debug('readdir "%s"', path);
      fs.readdir(path, function(err, files){
        if (err) return next(err);
        if (!hidden) files = removeHidden(files);
        if (filter) files = files.filter(function(filename, index, list) {
          return filter?.(filename, index, list, path);
        });
        files.sort();

        // content-negotiation
        const accept = accepts(req);
        const type = accept.type(mediaTypes) as string | false;

        // not acceptable
        if (!type) return next(createError(406));
        serveIndex[mediaType[type]](req, res, files, next, originalDir, showUp, icons, path, view, template, stylesheet);
      });
    });
  };
};

/**
 * Respond with text/html.
 */

serveIndex.html = function _html(req: IncomingMessage, res: ServerResponse, files: string[], next: Function, dir: string, showUp: boolean, icons: boolean | undefined, path: string, view: string, template: string | ((locals: TemplateLocal, callback: RenderCallback) => void), stylesheet: string) {
  const render = typeof template !== 'function'
    ? createHtmlRender(template)
    : template

  if (showUp) {
    files.unshift('..');
  }

  // stat all files
  stat(path, files, function (err, fileList) {
    if (err) return next(err);

    // sort file list
    fileList.sort(fileSort);

    // read stylesheet
    fs.readFile(stylesheet, 'utf8', function (err, style) {
      if (err) return next(err);

      // create locals for rendering
      const locals: TemplateLocal = {
        directory: dir,
        displayIcons: Boolean(icons),
        fileList: fileList,
        path: path,
        style: style,
        viewName: view
      };

      // render html
      render(locals, function (err, body) {
        if (err) return next(err);
        send(res, 'text/html', body as string)
      });
    });
  });
};

/**
 * Respond with application/json.
 */

serveIndex.json = function _json(req: IncomingMessage, res: ServerResponse, files: string[], next: Function, dir: string, showUp: boolean, icons: boolean | undefined, path: string, view: string, template: string | ((locals: TemplateLocal, callback: RenderCallback) => void), stylesheet: string) {
  // stat all files
  stat(path, files, function (err, fileList) {
    if (err) return next(err)

    // sort file list
    fileList.sort(fileSort)

    // serialize
    const body = JSON.stringify(fileList.map(function (file) {
      return file.name
    }))

    send(res, 'application/json', body)
  })
};

/**
 * Respond with text/plain.
 */

serveIndex.plain = function _plain(req: IncomingMessage, res: ServerResponse, files: string[], next: Function, dir: string, showUp: boolean, icons: boolean | undefined, path: string, view: string, template: string | ((locals: TemplateLocal, callback: RenderCallback) => void), stylesheet: string) {
  // stat all files
  stat(path, files, function (err, fileList) {
    if (err) return next(err)

    // sort file list
    fileList.sort(fileSort)

    // serialize
    const body = fileList.map(function (file) {
      return file.name
    }).join('\n') + '\n'

    send(res, 'text/plain', body)
  })
};

/**
 * Map html `files`, returning an html unordered list.
 * @private
 */

function createHtmlFileList(files: TemplateLocalFilter[], dir: string, useIcons: boolean, view: string) {
  let html = '<ul id="files" class="view-' + escapeHtml(view) + '">'
    + (view === 'details' ? (
      '<li class="header">'
      + '<span class="name">Name</span>'
      + '<span class="size">Size</span>'
      + '<span class="date">Modified</span>'
      + '</li>') : '');

  html += files.map(function (file) {
    const classes: string[] = [];
    const isDir = file.stat && file.stat.isDirectory();
    const path = dir.split('/').map(function (c) { return encodeURIComponent(c); });

    if (useIcons) {
      classes.push('icon');

      if (isDir) {
        classes.push('icon-directory');
      } else {
        const ext = extname(file.name);
        const icon = iconLookup(file.name);

        classes.push('icon');
        classes.push('icon-' + ext.substring(1));

        if (classes.indexOf(icon.className) === -1) {
          classes.push(icon.className);
        }
      }
    }

    path.push(encodeURIComponent(file.name));

    const date = file.stat && file.name !== '..'
      ? file.stat.mtime.toLocaleDateString() + ' ' + file.stat.mtime.toLocaleTimeString()
      : '';
    const size = file.stat && !isDir
      ? String(file.stat.size)
      : '';

    return '<li><a href="'
      + escapeHtml(normalizeSlashes(normalize(path.join('/'))))
      + '" class="' + escapeHtml(classes.join(' ')) + '"'
      + ' title="' + escapeHtml(file.name) + '">'
      + '<span class="name">' + escapeHtml(file.name) + '</span>'
      + '<span class="size">' + escapeHtml(size) + '</span>'
      + '<span class="date">' + escapeHtml(date) + '</span>'
      + '</a></li>';
  }).join('\n');

  html += '</ul>';

  return html;
}

/**
 * Create function to render html.
 */

function createHtmlRender(template: string) {
  return function render(locals: TemplateLocal, callback: RenderCallback) {
    // read template
    fs.readFile(template, 'utf8', function (err, str) {
      if (err) return callback(err);

      var body = str
        .replace(/\{style\}/g, (locals.style as string).concat(iconStyle(locals.fileList, locals.displayIcons)))
        .replace(/\{files\}/g, createHtmlFileList(locals.fileList, locals.directory, locals.displayIcons, locals.viewName))
        .replace(/\{directory\}/g, escapeHtml(locals.directory))
        .replace(/\{linked-path\}/g, htmlPath(locals.directory));

      callback(null, body);
    });
  };
}

/**
 * Sort function for with directories first.
 */

function fileSort(a: TemplateLocalFilter, b: TemplateLocalFilter) {
  // sort ".." to the top
  if (a.name === '..' || b.name === '..') {
    return a.name === b.name ? 0
      : a.name === '..' ? -1 : 1;
  }

  return Number(b.stat && b.stat.isDirectory()) - Number(a.stat && a.stat.isDirectory()) ||
    String(a.name).toLocaleLowerCase().localeCompare(String(b.name).toLocaleLowerCase());
}

/**
 * Get the requested directory from request.
 *
 * @param req
 * @return {string}
 * @api private
 */

function getRequestedDir (req: IncomingMessage): string | null {
  try {
    return decodeURIComponent(parseUrl(req)?.pathname ?? "")
  } catch (e) {
    return null
  }
}

/**
 * Map html `dir`, returning a linked path.
 */

function htmlPath(dir: string): string {
  const parts = dir.split('/');
  const crumb: string[] = new Array(parts.length);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part) {
      parts[i] = encodeURIComponent(part);
      crumb[i] = '<a href="' + escapeHtml(parts.slice(0, i + 1).join('/')) + '">' + escapeHtml(part) + '</a>';
    }
  }

  return crumb.join(' / ');
}

/**
 * Get the icon data for the file name.
 */

function iconLookup(filename: string): { className: string, fileName: typeof icons[keyof typeof icons] } {
  const ext = extname(filename);

  // try by extension
  if (icons[ext]) {
    return {
      className: 'icon-' + ext.substring(1),
      fileName: icons[ext]
    };
  }

  const mimetype = mime.lookup(ext);

  // default if no mime type
  if (mimetype === false) {
    return {
      className: 'icon-default',
      fileName: icons.default
    };
  }

  // try by mime type
  if (icons[mimetype]) {
    return {
      className: 'icon-' + mimetype.replace('/', '-').replace('+', '_'),
      fileName: icons[mimetype]
    };
  }

  const suffix = mimetype.split('+')[1];

  if (suffix && icons['+' + suffix]) {
    return {
      className: 'icon-' + suffix,
      fileName: icons['+' + suffix]
    };
  }

  const type = mimetype.split('/')[0];

  // try by type only
  if (icons[type]) {
    return {
      className: 'icon-' + type,
      fileName: icons[type]
    };
  }

  return {
    className: 'icon-default',
    fileName: icons.default
  };
}

/**
 * Load icon images, return css string.
 */

function iconStyle(files: TemplateLocalFilter[], useIcons: boolean): string {
  if (!useIcons) return '';
  const list: (typeof icons[keyof typeof icons])[] = [];
  const rules: {[iconName: string]: `background-image: url(data:image/png;base64,${string});`} = {};
  const selectors: {[iconName: string]: string[]} = {};
  let style = '';

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    const isDir = file.stat && file.stat.isDirectory();
    const icon = isDir
      ? { className: 'icon-directory', fileName: icons.folder }
      : iconLookup(file.name);
    const iconName = icon.fileName;

    const selector = '#files .' + icon.className + ' .name';

    if (!rules[iconName]) {
      rules[iconName] = `background-image: url(data:image/png;base64,${load(iconName)});`
      selectors[iconName] = [];
      list.push(iconName);
    }

    if (selectors[iconName].indexOf(selector) === -1) {
      selectors[iconName].push(selector);
    }
  }

  for (let i = 0; i < list.length; i++) {
    const iconName = list[i];
    style += selectors[iconName].join(',\n') + ' {\n  ' + rules[iconName] + '\n}\n';
  }

  return style;
}

/**
 * Load and cache the given `icon`.
 *
 * @param {string} icon
 * @return {string}
 * @api private
 */

function load(icon: string): string {
  if (cache[icon]) return cache[icon];
  return cache[icon] = fs.readFileSync(__dirname + '/public/icons/' + icon, 'base64');
}

/**
 * Normalizes the path separator from system separator
 * to URL separator, aka `/`.
 *
 * @param {string} path
 * @return {string}
 * @api private
 */

function normalizeSlashes(path: string): string {
  return path.split(sep).join('/');
};

/**
 * Filter "hidden" `files`, aka files
 * beginning with a `.`.
 *
 * @param {Array} files
 * @return {Array}
 * @api private
 */

function removeHidden(files: string[]): string[] {
  return files.filter(function(file){
    return file[0] !== '.'
  });
}

/**
 * Send a response.
 * @private
 */

function send (res: ServerResponse, type: string, body: string): void {
  // security header for content sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff')

  // standard headers
  res.setHeader('Content-Type', type + '; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'))

  // body
  res.end(body, 'utf8')
}

/**
 * Stat all files and return array of objects in the form
 * `{ name, stat }`.
 *
 * @api private
 */

function stat(dir: string, files: string[], cb: (err: NodeJS.ErrnoException | null, data: {name: string, stat: fs.Stats | null}[]) => void) {
  const batch = new Batch();

  batch.concurrency(10);

  files.forEach(function(file){
    batch.push(function(done){
      fs.stat(join(dir, file), function(err, stat){
        if (err && err.code !== 'ENOENT') return done(err);

        // pass ENOENT as null stat, not error
        done(null, {
          name: file,
          stat: stat || null
        })
      });
    });
  });

  batch.end(cb);
}

/**
 * Icon map.
 */

const icons = {
  // base icons
  'default': 'page_white.png',
  'folder': 'folder.png',

  // generic mime type icons
  'font': 'font.png',
  'image': 'image.png',
  'text': 'page_white_text.png',
  'video': 'film.png',

  // generic mime suffix icons
  '+json': 'page_white_code.png',
  '+xml': 'page_white_code.png',
  '+zip': 'box.png',

  // specific mime type icons
  'application/javascript': 'page_white_code_red.png',
  'application/json': 'page_white_code.png',
  'application/msword': 'page_white_word.png',
  'application/pdf': 'page_white_acrobat.png',
  'application/postscript': 'page_white_vector.png',
  'application/rtf': 'page_white_word.png',
  'application/vnd.ms-excel': 'page_white_excel.png',
  'application/vnd.ms-powerpoint': 'page_white_powerpoint.png',
  'application/vnd.oasis.opendocument.presentation': 'page_white_powerpoint.png',
  'application/vnd.oasis.opendocument.spreadsheet': 'page_white_excel.png',
  'application/vnd.oasis.opendocument.text': 'page_white_word.png',
  'application/x-7z-compressed': 'box.png',
  'application/x-sh': 'application_xp_terminal.png',
  'application/x-msaccess': 'page_white_database.png',
  'application/x-shockwave-flash': 'page_white_flash.png',
  'application/x-sql': 'page_white_database.png',
  'application/x-tar': 'box.png',
  'application/x-xz': 'box.png',
  'application/xml': 'page_white_code.png',
  'application/zip': 'box.png',
  'image/svg+xml': 'page_white_vector.png',
  'text/css': 'page_white_code.png',
  'text/html': 'page_white_code.png',
  'text/less': 'page_white_code.png',

  // other, extension-specific icons
  '.accdb': 'page_white_database.png',
  '.apk': 'box.png',
  '.app': 'application_xp.png',
  '.as': 'page_white_actionscript.png',
  '.asp': 'page_white_code.png',
  '.aspx': 'page_white_code.png',
  '.bat': 'application_xp_terminal.png',
  '.bz2': 'box.png',
  '.c': 'page_white_c.png',
  '.cab': 'box.png',
  '.cfm': 'page_white_coldfusion.png',
  '.clj': 'page_white_code.png',
  '.cc': 'page_white_cplusplus.png',
  '.cgi': 'application_xp_terminal.png',
  '.cpp': 'page_white_cplusplus.png',
  '.cs': 'page_white_csharp.png',
  '.db': 'page_white_database.png',
  '.dbf': 'page_white_database.png',
  '.deb': 'box.png',
  '.dll': 'page_white_gear.png',
  '.dmg': 'drive.png',
  '.docx': 'page_white_word.png',
  '.erb': 'page_white_ruby.png',
  '.exe': 'application_xp.png',
  '.fnt': 'font.png',
  '.gam': 'controller.png',
  '.gz': 'box.png',
  '.h': 'page_white_h.png',
  '.ini': 'page_white_gear.png',
  '.iso': 'cd.png',
  '.jar': 'box.png',
  '.java': 'page_white_cup.png',
  '.jsp': 'page_white_cup.png',
  '.lua': 'page_white_code.png',
  '.lz': 'box.png',
  '.lzma': 'box.png',
  '.m': 'page_white_code.png',
  '.map': 'map.png',
  '.msi': 'box.png',
  '.mv4': 'film.png',
  '.pdb': 'page_white_database.png',
  '.php': 'page_white_php.png',
  '.pl': 'page_white_code.png',
  '.pkg': 'box.png',
  '.pptx': 'page_white_powerpoint.png',
  '.psd': 'page_white_picture.png',
  '.py': 'page_white_code.png',
  '.rar': 'box.png',
  '.rb': 'page_white_ruby.png',
  '.rm': 'film.png',
  '.rom': 'controller.png',
  '.rpm': 'box.png',
  '.sass': 'page_white_code.png',
  '.sav': 'controller.png',
  '.scss': 'page_white_code.png',
  '.srt': 'page_white_text.png',
  '.tbz2': 'box.png',
  '.tgz': 'box.png',
  '.tlz': 'box.png',
  '.vb': 'page_white_code.png',
  '.vbs': 'page_white_code.png',
  '.xcf': 'page_white_picture.png',
  '.xlsx': 'page_white_excel.png',
  '.yaws': 'page_white_code.png'
} as const;

interface ServeIndexOptions {
  /**
   * Apply this filter function to files. Defaults to `false`. The filter function is called for each file,
   * with the signature `filter(filename, index, files, dir)` where filename is the name of the file, index is the array index,
   * files is the array of files and dir is the absolute path the file is located (and thus, the directory the listing is for).
   */
  filter?: false | ((filename: string, index: number, list: string[], path: string) => boolean);
  /**
   * Display hidden (dot) files. Defaults to `false`.
   */
  hidden?: boolean;
  /**
   * Display icons. Defaults to `false`.
   */
  icons?: boolean;
  /**
   * Optional path to a CSS stylesheet. Defaults to a built-in stylesheet.
   */
  stylesheet?: string;
  /**
   * Optional path to an HTML template or a function that will render a HTML string. Defaults to a built-in template.
   *
   * When given a string, the string is used as a file path to load and then the following tokens are replaced in templates:
   *
   * - `{directory}` with the name of the directory.
   * - `{files}` with the HTML of an unordered list of file links.
   * - `{linked-path}` with the HTML of a link to the directory.
   * - `{style}` with the specified stylesheet and embedded images.
   *
   * When given as a function, the function is called as `template(locals, callback)` and it needs to invoke `callback(error, htmlString)`. The following are the provided locals:
   *
   * - `directory` is the directory being displayed (where / is the root).
   * - `displayIcons` is a Boolean for if icons should be rendered or not.
   * - `fileList` is a sorted array of files in the directory. The array contains objects with the following properties:
   *   - `name` is the relative name for the file.
   *   - `stat` is a `fs.Stats` object for the file.
   * - `path` is the full filesystem path to directory.
   * - `style` is the default stylesheet or the contents of the stylesheet option.
   * - `viewName` is the view name provided by the view option.
   */
  template?: string | ((locals: TemplateLocal, callback: RenderCallback) => void);
  view?: string
}

type RenderCallback = (error: NodeJS.ErrnoException | null, htmlString?: string) => void;

interface TemplateLocal {
  directory: string;
  displayIcons: boolean;
  fileList: TemplateLocalFilter[];
  path: string;
  style: string | string[];
  viewName: string;
}

interface TemplateLocalFilter {
  name: string;
  stat: fs.Stats | null;
}
