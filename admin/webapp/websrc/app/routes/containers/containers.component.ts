import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnInit, ViewChild } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { MapConstant } from '@common/constants/map.constant';
import { ErrorResponse, ScanConfig, WorkloadV2 } from '@common/types';
import { UtilsService } from '@common/utils/app.utils';
import { AuthUtilsService } from '@common/utils/auth.utils';
import { ContainersGridComponent } from '@components/containers-grid/containers-grid.component';
import { TranslateService } from '@ngx-translate/core';
import { ContainersService, WorkloadRow } from '@services/containers.service';
import { NotificationService } from '@services/notification.service';
import { MultiClusterService } from '@services/multi-cluster.service';
import { ScanService } from '@services/scan.service';
import { interval, Subject } from 'rxjs';
import { finalize, takeUntil } from 'rxjs/operators';
import { GlobalVariable } from '@common/variables/global.variable';

@Component({
  selector: 'app-containers',
  templateUrl: './containers.component.html',
  styleUrls: ['./containers.component.scss'],
})
export class ContainersComponent implements OnInit {
  _containersGrid!: ContainersGridComponent;
  private switchClusterSubscription;

  @ViewChild(ContainersGridComponent) set containersGrid(
    grid: ContainersGridComponent
  ) {
    this._containersGrid = grid;
    if (this._containersGrid) {
      this._containersGrid.selectedContainer$.subscribe(container => {
        if (container) this.selectedContainer = container;
      });
    }
  }
  get containersGrid() {
    return this._containersGrid;
  }
  quarantinedContainers: WorkloadV2[] = [];
  toggleNodeForm!: FormGroup;
  refreshing$ = new Subject();
  error!: string;
  loaded = false;
  isPrinting: boolean = false;
  autoScan = new FormControl(false);
  autoScanAuthorized = false;
  isAutoScanAuthorized!: boolean;
  stopFullScan$ = new Subject();
  stopContainerScan$ = new Subject();
  selectedContainer!: WorkloadRow;
  infoTemplate!: 'compliance' | 'vulnerabilities' | '';
  get auto_scan() {
    return this.autoScan.value;
  }
  get containers() {
    return this.containersService.containers;
  }
  get isScannerInstalled() {
    return GlobalVariable.summary.scanners !== 0;
  }

  constructor(
    private containersService: ContainersService,
    private scanService: ScanService,
    private notificationService: NotificationService,
    private authUtils: AuthUtilsService,
    private utils: UtilsService,
    private tr: TranslateService,
    private multiClusterService: MultiClusterService,
    private cd: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.isAutoScanAuthorized = this.authUtils.getDisplayFlag('runtime_scan');
    this.toggleNodeForm = new FormGroup({
      systemNode: new FormControl(true),
      exitNode: new FormControl(false),
    });
    this.getContainers();
    if (this.isAutoScanAuthorized) this.getScanConfig();
    //refresh the page when it switched to a remote cluster
    this.switchClusterSubscription =
      this.multiClusterService.onClusterSwitchedEvent$.subscribe(data => {
        this.refresh();
      });
  }

  ngOnDestroy(): void {
    if (this.switchClusterSubscription) {
      this.switchClusterSubscription.unsubscribe();
    }
  }
  refresh(
    cb?: (containers: WorkloadV2[], displayContainers: WorkloadRow[]) => void
  ): void {
    this.refreshing$.next(true);
    this.getContainers(cb);
  }

  getContainers(
    cb?: (containers: WorkloadV2[], displayContainers: WorkloadRow[]) => void
  ) {
    this.containersService.resetContainers();
    this.containersService
      .getScannedContainers()
      .pipe(
        // tapOnce(() => this.containersService.resetContainers()),
        finalize(() => {
          this.loaded = true;
          this.refreshing$.next(false);
          if (cb)
            cb(
              this.containersService.containers,
              this.containersService.displayContainers
            );
          this.cd.detectChanges();
        })
      )
      .subscribe({
        next: res => {
          this.containersService.addContainers(res);
          this.quarantinedContainers =
            this.containersService.quarantinedContainers;
          this.nodeFilterInit(res);
          this.error = '';
          if (!this.loaded) this.loaded = true;
        },
        error: ({ error }: { error: ErrorResponse }) => {},
      });
  }

  getScanConfig() {
    this.scanService.getScanConfig().subscribe({
      next: (config: ScanConfig) => {
        this.autoScan.setValue(config.auto_scan);
        this.autoScanAuthorized = true;
      },
      error: (error: HttpErrorResponse) => {
        if (error.status === MapConstant.ACC_FORBIDDEN) {
          this.autoScanAuthorized = false;
        }
        this.notificationService.open(
          this.utils.getAlertifyMsg(
            error.error,
            this.tr.instant('scan.message.CONFIG_ERR'),
            false
          )
        );
      },
    });
  }

  configAutoScan(auto_scan: boolean) {
    this.scanService.postScanConfig({ auto_scan }).subscribe(() => {
      if (auto_scan) {
        interval(8000)
          .pipe(takeUntil(this.stopFullScan$))
          .subscribe(() => {
            this.refresh(containers => {
              if (this.scanService.isScanWorkloadsFinished(containers))
                this.stopFullScan$.next(true);
            });
          });
      } else {
        this.stopFullScan$.next(true);
      }
    });
  }

  configScan(selectedContainer: WorkloadRow) {
    this.scanService.scanContainer(selectedContainer.brief.id).subscribe({
      complete: () => {
        this.notificationService.open(this.tr.instant('scan.START_SCAN'));
        selectedContainer.security.scan_summary.status = 'scanning';
        this.containersGrid.gridApi
          .getRowNode(selectedContainer.brief.id)
          ?.setData(selectedContainer);
        interval(5000)
          .pipe(takeUntil(this.stopContainerScan$))
          .subscribe(() => {
            this.refresh((_containers, displayContainers) => {
              const workload = displayContainers.find(
                w => w.brief.id === selectedContainer.brief.id
              );
              if (
                !workload ||
                this.scanService.isContainerScanFinished(workload)
              ) {
                this.stopContainerScan$.next(true);
              }
            });
          });
      },
      error: ({ error }: { error: ErrorResponse }) => {
        this.notificationService.open(
          this.utils.getAlertifyMsg(
            error,
            this.tr.instant('scan.FAILED_SCAN'),
            false
          )
        );
      },
    });
  }

  nodeFilterInit(containers: WorkloadV2[]): void {
    this.containersService.addDisplayContainers(
      this.containersService.filterNode(this.toggleNodeForm.value, containers)
    );
  }

  nodeFilterChange(): void {
    this.containersService.displayContainers =
      this.containersService.filterNode(
        this.toggleNodeForm.value,
        this.containers
      );
  }

  print = () => {
    this.isPrinting = true;
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        this.isPrinting = false;
      }, 1000);
    }, 1000);
  };
}
