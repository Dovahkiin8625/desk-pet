/**
 * Windows 的设置页清单。
 *
 * Win+S 除了应用与文件，还能搜到**系统设置**（「蓝牙和设备」「电源和睡眠」……）。
 * 桌宠的搜索框要覆盖到这一块，就得有这些页面的名字与地址。
 *
 * 页面地址是 `ms-settings:` URI（Windows 10 起的系统设置）；
 * 有一小部分传统的东西只在「控制面板」里（`control.exe /name …`），也一并收进来。
 *
 * 名字写死成中文：这个项目只做中文界面，
 * 而系统设置的页面标题取决于系统语言，跟着系统语言变反而对不上。
 */
export const SETTINGS_PAGES = [
  // —— 系统 ——
  { id: 'settings:system', name: '系统', target: 'ms-settings:', hint: '系统设置' },
  { id: 'settings:about', name: '系统信息', target: 'ms-settings:about', hint: '系统设置' },
  { id: 'settings:display', name: '显示', target: 'ms-settings:display', hint: '系统设置' },
  { id: 'settings:displayAdvanced', name: '高级显示', target: 'ms-settings:display-advanced', hint: '系统设置' },
  { id: 'settings:sound', name: '声音', target: 'ms-settings:sound', hint: '系统设置' },
  { id: 'settings:notifications', name: '通知', target: 'ms-settings:notifications', hint: '系统设置' },
  { id: 'settings:focus', name: '专注助手', target: 'ms-settings:focus', hint: '系统设置' },
  { id: 'settings:power', name: '电源和睡眠', target: 'ms-settings:powersleep', hint: '系统设置' },
  { id: 'settings:storage', name: '存储', target: 'ms-settings:storagesense', hint: '系统设置' },
  { id: 'settings:multitasking', name: '多任务处理', target: 'ms-settings:multitasking', hint: '系统设置' },
  { id: 'settings:startup', name: '启动应用', target: 'ms-settings:startupapps', hint: '系统设置' },
  { id: 'settings:defaultApps', name: '默认应用', target: 'ms-settings:defaultapps', hint: '系统设置' },
  { id: 'settings:appsFeatures', name: '应用和功能', target: 'ms-settings:appsfeatures', hint: '系统设置' },
  { id: 'settings:dateTime', name: '日期和时间', target: 'ms-settings:dateandtime', hint: '系统设置' },
  { id: 'settings:clockLanguage', name: '时间和语言', target: 'ms-settings:clockandlanguage', hint: '系统设置' },
  { id: 'settings:region', name: '区域', target: 'ms-settings:region', hint: '系统设置' },
  { id: 'settings:language', name: '语言和区域', target: 'ms-settings:language', hint: '系统设置' },
  { id: 'settings:taskbar', name: '任务栏', target: 'ms-settings:taskbar', hint: '系统设置' },
  { id: 'settings:homepage', name: '主页', target: 'ms-settings:homepage', hint: '系统设置' },
  { id: 'settings:lockScreen', name: '锁屏界面', target: 'ms-settings:lock', hint: '系统设置' },
  { id: 'settings:recycleBin', name: '回收站', target: 'ms-settings:recyclebin', hint: '系统设置' },
  { id: 'settings:printers', name: '打印机和扫描仪', target: 'ms-settings:printers', hint: '系统设置' },
  { id: 'settings:mouseTouchpad', name: '鼠标和触控板', target: 'ms-settings:mousetouchpad', hint: '系统设置' },
  { id: 'settings:keyboard', name: '键盘', target: 'ms-settings:keyboard', hint: '系统设置' },
  { id: 'settings:gameBar', name: '游戏栏', target: 'ms-settings:gaminggamebar', hint: '系统设置' },
  { id: 'settings:gameMode', name: '游戏模式', target: 'ms-settings:gaminggamemode', hint: '系统设置' },
  { id: 'settings:gaming', name: '游戏', target: 'ms-settings:gaming', hint: '系统设置' },
  { id: 'settings:xbox', name: 'Xbox', target: 'ms-settings:xbox', hint: '系统设置' },

  // —— 设备与网络 ——
  { id: 'settings:bluetooth', name: '蓝牙和设备', target: 'ms-settings:bluetooth', hint: '系统设置' },
  { id: 'settings:devices', name: '设备', target: 'ms-settings:devices', hint: '系统设置' },
  { id: 'settings:network', name: '网络和 Internet', target: 'ms-settings:network', hint: '系统设置' },
  { id: 'settings:wifi', name: 'Wi-Fi', target: 'ms-settings:network-wifi', hint: '系统设置' },
  { id: 'settings:airplane', name: '飞行模式', target: 'ms-settings:airplanemode', hint: '系统设置' },
  { id: 'settings:ethernet', name: '以太网', target: 'ms-settings:ethernet', hint: '系统设置' },
  { id: 'settings:hotspot', name: '移动热点', target: 'ms-settings:mobilehotspot', hint: '系统设置' },
  { id: 'settings:vpn', name: 'VPN', target: 'ms-settings:vpn', hint: '系统设置' },
  { id: 'settings:proxy', name: '代理', target: 'ms-settings:proxy', hint: '系统设置' },

  // —— 个性化与账户 ——
  { id: 'settings:personalization', name: '个性化', target: 'ms-settings:personalization', hint: '系统设置' },
  { id: 'settings:background', name: '背景', target: 'ms-settings:background', hint: '系统设置' },
  { id: 'settings:colors', name: '颜色', target: 'ms-settings:colors', hint: '系统设置' },
  { id: 'settings:themes', name: '主题', target: 'ms-settings:themes', hint: '系统设置' },
  { id: 'settings:fonts', name: '字体', target: 'ms-settings:fonts', hint: '系统设置' },
  { id: 'settings:accounts', name: '账户', target: 'ms-settings:accounts', hint: '系统设置' },
  { id: 'settings:emailAccounts', name: '电子邮件和账户', target: 'ms-settings:emailandaccounts', hint: '系统设置' },
  { id: 'settings:signin', name: '登录选项', target: 'ms-settings:signinoptions', hint: '系统设置' },
  { id: 'settings:otherUsers', name: '其他用户', target: 'ms-settings:otherusers', hint: '系统设置' },
  { id: 'settings:timeoutsession', name: '注销选项', target: 'ms-settings:timeoutsession', hint: '系统设置' },
  { id: 'settings:sync', name: '同步你的电脑', target: 'ms-settings:syncpc', hint: '系统设置' },

  // —— 隐私与安全 ——
  { id: 'settings:privacy', name: '隐私和安全性', target: 'ms-settings:privacy', hint: '系统设置' },
  { id: 'settings:privacyGeneral', name: '常规', target: 'ms-settings:privacyGeneral', hint: '系统设置' },
  { id: 'settings:privacyCamera', name: '相机', target: 'ms-settings:privacycamera', hint: '系统设置' },
  { id: 'settings:privacyMicrophone', name: '麦克风', target: 'ms-settings:privacymicrophone', hint: '系统设置' },
  { id: 'settings:privacyLocation', name: '位置', target: 'ms-settings:privacyLocation', hint: '系统设置' },
  { id: 'settings:privacyAdvertising', name: '广告', target: 'ms-settings:privacyadvertising', hint: '系统设置' },
  { id: 'settings:security', name: 'Windows 安全中心', target: 'ms-settings:defender', hint: '系统设置' },
  { id: 'settings:update', name: '更新和安全', target: 'ms-settings:windowsupdate', hint: '系统设置' },
  { id: 'settings:recovery', name: '恢复', target: 'ms-settings:recovery', hint: '系统设置' },
  { id: 'settings:activation', name: '激活', target: 'ms-settings:activation', hint: '系统设置' },
  { id: 'settings:deliveryOptimization', name: '传递优化', target: 'ms-settings:deliveryoptimization', hint: '系统设置' },

  // —— 辅助功能与其他 ——
  { id: 'settings:easeOfAccess', name: '辅助功能', target: 'ms-settings:easeofaccess', hint: '系统设置' },
  { id: 'settings:magnifier', name: '放大镜', target: 'ms-settings:magnifier', hint: '系统设置' },
  { id: 'settings:narrator', name: '讲述人', target: 'ms-settings:narrator', hint: '系统设置' },
  { id: 'settings:speech', name: '语音', target: 'ms-settings:speech', hint: '系统设置' },
  { id: 'settings:highContrast', name: '高对比度主题', target: 'ms-settings:highcontrast', hint: '系统设置' },
  { id: 'settings:search', name: '搜索', target: 'ms-settings:search', hint: '系统设置' },
  { id: 'settings:windowsSearch', name: 'Windows 搜索', target: 'ms-settings:windowssearch', hint: '系统设置' },
  { id: 'settings:messaging', name: '消息传递', target: 'ms-settings:messaging', hint: '系统设置' },
  { id: 'settings:phone', name: '电话', target: 'ms-settings:phone', hint: '系统设置' },

  // —— 控制面板（还没搬进系统设置的那些）——
  { id: 'control:panel', name: '控制面板', target: 'control.exe', hint: '控制面板' },
  { id: 'control:power', name: '电源选项', target: 'control.exe /name Microsoft.PowerOptions', hint: '控制面板' },
  { id: 'control:sound', name: '声音（传统）', target: 'control.exe /name Microsoft.Sound', hint: '控制面板' },
  { id: 'control:network', name: '网络连接', target: 'control.exe /name Microsoft.NetworkConnections', hint: '控制面板' },
  { id: 'control:users', name: '用户账户', target: 'control.exe /name Microsoft.UserAccounts', hint: '控制面板' },
  { id: 'control:fileOptions', name: '文件夹选项', target: 'control.exe /name Microsoft.FileOptions', hint: '控制面板' },
  { id: 'control:systemProperties', name: '系统属性', target: 'control.exe /name Microsoft.SystemProperties', hint: '控制面板' },
  { id: 'control:performance', name: '性能', target: 'control.exe /name Microsoft.Performance', hint: '控制面板' },
  { id: 'control:services', name: '服务', target: 'control.exe /name Microsoft.Services', hint: '控制面板' },
  { id: 'control:eventViewer', name: '事件查看器', target: 'control.exe /name Microsoft.EventViewer', hint: '控制面板' },
  { id: 'control:deviceManager', name: '设备管理器', target: 'control.exe /name Microsoft.DeviceManager', hint: '控制面板' },
  { id: 'control:programs', name: '程序和功能', target: 'control.exe /name Microsoft.ProgramsAndFeatures', hint: '控制面板' },
];

/** 设置项的图标：一律用同一个符号（系统设置没有各自的图标可取）。 */
export const SETTINGS_ICON = '⚙️';
