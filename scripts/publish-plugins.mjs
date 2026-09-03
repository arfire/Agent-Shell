#!/usr/bin/env node
import sh from 'shelljs'
import * as vars from './vars.mjs'
import log from 'npmlog'
import { execSync } from 'child_process'

vars.allPackages.forEach(plugin => {
    log.info('bump', plugin)
    sh.cd(plugin)
    sh.exec('npm --no-git-tag-version version ' + vars.tabbyVersion, { fatal: true })
    execSync('npm publish --tag latest', { stdio: 'inherit' })
    sh.cd('..')
})
