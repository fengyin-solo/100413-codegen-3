# 机场地面保障调度管理系统

面向航班机位分配、廊桥调度、行李转运、货物装卸、航空加油、航食配餐与客舱清洁全流程的机场地面保障调度管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 机位分配 | `stand` | 机位分配 | 机位编号、机位类型、所属航站楼 |
| 廊桥调度 | `bridge` | 廊桥对接队列 | 廊桥编号、所属机位、对接机型、调度人员、锁定时间、电源核验 |
| 地面电源 | `ground_power` | 地面电源 | 设备编号、设备类型、所属机位、占用廊桥 |
| 行李转运 | `baggage` | 行李转运 | 转运编号、关联航班、行李件数 |
| 货物装卸 | `cargo` | 货物装卸 | 装卸编号、关联航班、货物品类 |
| 航空加油 | `fueling` | 加油记录 | 加油编号、关联航班、燃油型号 |
| 航食配餐 | `catering` | 配餐任务 | 配餐编号、关联航班、餐食类型 |
| 客舱清洁 | `cabin_clean` | 清洁任务 | 清洁编号、关联航班、清洁类型 |
| 排污服务 | `lavatory` | 排污记录 | 排污编号、关联航班、服务车型 |
| 除冰作业 | `deicing` | 除冰记录 | 除冰编号、关联航班、除冰液类型 |
| 牵引车调度 | `pushback` | 牵引任务 | 牵引编号、关联航班、牵引车型 |
| 地勤排班 | `crew_schedule` | 地勤人员 | 人员编号、姓名、岗位类别 |
| 特种车辆 | `special_vehicle` | 特种车辆 | 车辆编号、车辆类型、品牌型号 |
| 航班保障 | `flight_ops` | 航班保障 | 航班号、机尾号、计划到港 |
| 过站监控 | `turnaround` | 过站记录 | 过站编号、关联航班、计划到港 |
| 机坪安全 | `apron_safety` | 机坪安全 | 巡查编号、巡查区域、巡查人员 |
| 装卸设备 | `load_equip` | 装卸设备 | 设备编号、设备类型、适用机型 |
| 应急保障 | `air_emergency` | 应急保障 | 应急编号、事件类型、涉及航班 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `airport-ground-handling:entries` 这一项（连同
  `airport-ground-handling:schema-version`），或调用 `resetModule(模块)`。

### 廊桥对接队列规则

廊桥调度（`bridge`）是线性流转模块，规则集中在 `src/api/local-service.ts` 的
`runBridgeAction`：

- **状态只能逐格推进**：待对接 → 已对接 → 已脱离 → 故障停用。越过中间环节或往回走都不受理，
  页面也只渲染当前状态的下一格动作；故障停用为归档终态，定格后无可用动作。
- **入队管理**：`enqueueBridge` 按廊桥编号、所属机位、对接机型、调度人员排入队尾，统一从
  「待对接」起步；`bridgeQueue` 分别给出待对接队列与已锁定机位的对接清单。
- **归属冲突**：同一廊桥（或同一机位）被两人同时安排时，以先执行「安排对接」锁定机位的一方为准，
  后到者直接拒绝并提示先锁定的调度人员与锁定时间。
- **地面电源台账同步**：安排对接时对同机位地面电源做占用核验——台账里无设备、设备故障停用、
  或已被其他廊桥占用，均不予受理；核验通过后台账同步置为供电中并登记占用廊桥。确认脱离时同步
  断电并解除占用。
- **存量迁移**：`src/data/migrations.ts` 负责旧版本地数据升级（当前 schema v2）。缺机位归属的
  廊桥/地面电源存量记录按机位台账补数；历史「故障停用」归档只补归属与新字段，原状态保持不动。
