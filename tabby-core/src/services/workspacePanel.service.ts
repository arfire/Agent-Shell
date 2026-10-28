import { Injectable } from '@angular/core'
import { Subject } from 'rxjs'

@Injectable({ providedIn: 'root' })
export class WorkspacePanelService {
    readonly requested = new Subject<string>()

    open (id: string): void {
        this.requested.next(id)
    }
}
