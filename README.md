# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查
- JSON 示例的类型、枚举和必填规则校验
- 发布候选契约比较、受影响下游依赖和迁移确认
- 数据、产品、客户端和测试四角色批量审批与发布门禁
- 事件废弃计划、替代事件和迁移说明
- 发布回滚记录与结果验证
- JSON 契约和 Markdown 契约文档导出

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18474`。

## 构建

```bash
npm run build
```

## 数据层

- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：Pinia 编辑、审批、废弃和回滚状态
- `src/services/selectors.ts`：契约快照、快照漂移、契约比较、影响分析和校验规则

## 契约快照与回执语义

- 创建发布候选时冻结完整契约快照（字段、必填、枚举、平台规则），候选携带 `snapshotRevision` 修订号；差异、受影响下游、发布与回滚均以快照为准
- 两个客户端窗口各自持有已同步修订：回执基准修订与当前快照不一致时退回；同一幂等键的回执只处理一次（重复返回 `duplicate`）；校验失败或被退回的回执保留在回执台账中，可沿用原幂等键重试
- 评审期间字段、必填或平台规则发生变化时，相关下游迁移确认与该候选已通过的审批置为失效（`invalidated`）并列待重算；重算后快照刷新、修订号自增、失效项回到待处理
- 发布使用当前冻结快照（存在未重算漂移时拦截）；回滚将契约恢复到目标版本的已发布快照，目标版本之后新增的事件、字段和平台规则保留不删除
