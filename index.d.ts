import type { Handler } from "express";
import type { Stats } from "node:fs";

/** Serves pages that contain directory listings for a given path. */
declare function serveIndex(path: string, options?: serveIndex.Options): Handler;

declare namespace serveIndex {
    interface File {
        name: string;
        stat: Stats;
    }

    interface Locals {
        directory: string;
        displayIcons: boolean;
        fileList: File[];
        name: string;
        stat: Stats;
        path: string;
        style: string;
        viewName: string;
    }

    type TemplateCallback = (error: Error | null, htmlString?: string) => void;

    interface Options {
        filter?: ((filename: string, index: number, files: File[], dir: string) => boolean) | undefined;
        hidden?: boolean | undefined;
        icons?: boolean | undefined;
        stylesheet?: string | undefined;
        template?: string | ((locals: Locals, callback: TemplateCallback) => void) | undefined;
        view?: string | undefined;
    }
}

export = serveIndex;
