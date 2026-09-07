import { Type } from '@angular/core'

/** Plugin content hosted in the application sidebar; receives a tab input. */
export abstract class WorkspacePanelProvider {
    abstract id: string
    abstract title: string
    abstract component: Type<unknown>
}
