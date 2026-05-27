import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "open-agent-harness-electron-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Open Agent Harness",
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    target: ["nsis"],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.openagentharness.desktop.dev",
        productName: "Open Agent Harness Dev",
        rpm: { packageName: "open-agent-harness-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.openagentharness.desktop.beta",
        productName: "Open Agent Harness Beta",
        protocols: { name: "Open Agent Harness Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "goodjin", repo: "open-agent-harness", channel: "beta" },
        rpm: { packageName: "open-agent-harness-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.openagentharness.desktop",
        productName: "Open Agent Harness",
        protocols: { name: "Open Agent Harness", schemes: ["opencode"] },
        publish: { provider: "github", owner: "goodjin", repo: "open-agent-harness", channel: "latest" },
        rpm: { packageName: "open-agent-harness" },
      }
    }
  }
}

export default getConfig()
