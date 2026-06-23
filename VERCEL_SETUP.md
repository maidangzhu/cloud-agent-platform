# Vercel 环境变量配置

## 必需的环境变量

项目需要两组环境变量才能正常运行：

### 1. Vercel Sandbox 凭证

用于创建代码执行沙箱环境。

#### 错误信息
```
Error: Vercel credentials not available: set VERCEL_TOKEN, or VERCEL_OIDC_TOKEN
```

#### 配置方法

**方案 1：使用 VERCEL_TOKEN（推荐）**

1. 获取 Personal Access Token：
   - 访问 https://vercel.com/account/tokens
   - 创建新 token，复制保存

2. 获取 Team ID 和 Project ID：
   ```bash
   # 本地运行（需要先 vercel link）
   vercel env ls
   # 或者从 Vercel Dashboard URL 获取
   # https://vercel.com/[TEAM_ID]/[PROJECT_NAME]
   ```

3. 在 Vercel 项目设置中添加：
   - `VERCEL_TOKEN` = `your_personal_access_token`
   - `VERCEL_TEAM_ID` = `team_xxx`
   - `VERCEL_PROJECT_ID` = `prj_xxx`

**方案 2：使用 OIDC（自动获取 team/project）**

Vercel 会自动注入 `VERCEL_OIDC_TOKEN`，但需要在项目设置中启用。

### 2. LLM API 凭证（必需）

用于调用 AI 模型生成代码和回复。

#### 错误信息
```
401 status code (no body)
```

#### 配置方法

需要配置以下环境变量：

- `OPENAI_API_KEY` = `your_api_key`（必需）
- `OPENAI_BASE_URL` = `https://your-relay.example.com/v1`（可选，默认为 OpenAI 官方）
- `LLM_MODEL` = `gpt-4o-mini`（可选，默认为 gpt-4o）

**如果使用中转站**：
- `OPENAI_BASE_URL` 设置为中转站地址
- `OPENAI_API_KEY` 设置为中转站的 API key

**如果使用 OpenAI 官方**：
- 不设置 `OPENAI_BASE_URL`（或设置为 `https://api.openai.com/v1`）
- `OPENAI_API_KEY` 设置为 OpenAI API key

## 配置步骤

1. 进入 Vercel 项目：https://vercel.com/maidangzhu/cloud-agent-platform
2. 点击 **Settings** → **Environment Variables**
3. 添加以上所有变量
4. 选择环境：**Production**, **Preview**, **Development**（全选）
5. 点击 **Save**
6. 重新部署项目（Settings → Deployments → Redeploy）

## 验证

部署完成后，访问首页发消息，应该能看到：
1. ✅ 沙箱正常创建（`workspace_ready`）
2. ✅ Agent 开始工作（`agent_started`）
3. ✅ 工具调用和回复正常显示

## 相关文件

- `src/server/sandbox/vercel-credentials.ts` - Sandbox 凭证解析
- `src/server/agent/model.ts` - LLM 配置解析
- `src/server/sandbox/factory.ts` - 沙箱创建入口
- `src/server/agent/run-agent.ts` - Agent 执行入口
