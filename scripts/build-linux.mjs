#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import * as vars from './vars.mjs'

process.env.ARCH = (process.env.ARCH || process.arch) === 'arm' ? 'armv7l' : process.env.ARCH || process.arch

builder({
    dir: true,
    linux: ['deb', 'tar.gz', 'rpm', 'pacman', 'appimage'],
    armv7l: process.env.ARCH === 'armv7l',
    arm64: process.env.ARCH === 'arm64',
    config: {
        npmRebuild: false,
        extraMetadata: {
            version: vars.version,
        },
        publish: null,
    },
    publish: 'never',
}).catch(e => {
    console.error(e)
    process.exit(1)
})
