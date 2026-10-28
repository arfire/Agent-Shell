#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import * as vars from './vars.mjs'

process.env.ARCH = process.env.ARCH || process.arch

process.env.APPLE_ID ??= process.env.APPSTORE_USERNAME
process.env.APPLE_APP_SPECIFIC_PASSWORD ??= process.env.APPSTORE_PASSWORD

builder({
    dir: true,
    mac: ['dmg', 'zip'],
    x64: process.env.ARCH === 'x86_64',
    arm64: process.env.ARCH === 'arm64',
    config: {
        extraMetadata: {
            version: vars.version,
            teamId: process.env.APPLE_TEAM_ID,
        },
        forceCodeSigning: !!process.env.CSC_LINK,
        mac: {
            identity: !process.env.CI || process.env.CSC_LINK ? undefined : null,
            notarize: !!process.env.APPLE_TEAM_ID,
        },
        npmRebuild: process.env.ARCH !== 'arm64',
        publish: null,
    },
    publish: 'never',
}).catch(e => {
    console.error(e)
    process.exit(1)
})
