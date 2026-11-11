# 桌宠的系统搜索助手：一个常驻的 PowerShell 进程。
#
# 它做两件事：
# 1. 查 **Windows 搜索索引**（Win+S 用的就是它）——按文件名与文件内容找出本机的文件；
# 2. 从文件里**抽图标**（开始菜单的快捷方式、程序、文档）——给搜索结果显示图标。
#
# 通信：stdin 上一行一个请求，stdout 上一行一个响应。
# **整行都是 base64（UTF-8 的 JSON）**：绕开控制台代码页，
# 中文路径与中文查询才不会变成乱码（PowerShell 读 stdin 用的是系统代码页，
# 直接发 UTF-8 会被按 GBK 解释——查「笔记」就永远查不到）。
#
# 请求：{"id":1,"op":"files","query":"记事","limit":20}
# 响应：{"id":1,"ok":true,"op":"files","items":[{"name":"…","path":"…","match":"name"}]}

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# 索引的连接：开一次就一直用着（每次查询都重开连接会慢一截）。
$script:index = $null

function Get-Index {
  if ($null -ne $script:index) { return $script:index }
  $conn = New-Object System.Data.OleDb.OleDbConnection "Provider=Search.CollatorDSO;Extended Properties='Application=Windows';"
  $conn.Open()
  $script:index = $conn
  return $conn
}

# LIKE 里的通配符要转义：% 与 _ 是「任意字符」，[ 与 ] 是字符组。
# 用户输入原样塞进 SQL 会把整条查询改写掉（打一个 % 就是全库）。
function ConvertTo-SafeLike([string]$text) {
  # 单引号要先 doubling：SQL 里它是字符串的边界。
  $text = $text.Replace("'", "''")
  return [regex]::Replace($text, '([%_\[\]])', { param($m) '[' + $m.Groups[1].Value + ']' })
}

# 索引给的是 file:C:/Users/... 这样的 URL：去掉协议头，把 / 换成 \，再解掉转义。
function ConvertFrom-ItemUrl([string]$url) {
  if ([string]::IsNullOrEmpty($url)) { return '' }
  $path = $url -replace '^file:', ''
  $path = $path -replace '^/+', ''
  $path = $path -replace '/', '\'
  try { $path = [System.Uri]::UnescapeDataString($path) } catch { }
  return $path
}

# 查文件：先按**文件名**找（每个词都要在名字里出现，AND，与 Win+S 的多词行为一致），
# 再按**内容**找（文档里的字也算）。
function Find-Files([string]$query, [int]$limit) {
  $tokens = @($query -split '\s+' | Where-Object { $_ -ne '' })
  if ($tokens.Count -eq 0) { return @() }
  if ($limit -lt 1) { $limit = 20 }
  if ($limit -gt 100) { $limit = 100 }
  $where = @()
  foreach ($token in $tokens) {
    $safe = ConvertTo-SafeLike $token
    $where += "System.ItemNameDisplay LIKE '%$safe%'"
  }
  # 目录不列：搜索结果里全是文件夹反而把文件挤走。
  $filter = "(System.ItemType IS NULL OR System.ItemType <> 'Directory')"
  $sql = "SELECT TOP $limit System.ItemNameDisplay, System.ItemUrl FROM SYSTEMINDEX WHERE " +
    ($where -join ' AND ') + " AND $filter"
  $items = @()
  foreach ($row in (Invoke-Query $sql)) {
    $row.match = 'name'
    $items += $row
  }
  # 再找**内容里**有这个词的：Win+S 找得到文档里的字，桌宠也得找得到。
  $content = ConvertTo-ContentQuery $query
  if ($content -ne '') {
    $sql = "SELECT TOP $limit System.ItemNameDisplay, System.ItemUrl FROM SYSTEMINDEX WHERE " +
      "CONTAINS(System.Search.Contents, '$content') AND $filter"
    try {
      foreach ($row in (Invoke-Query $sql)) {
        # 名字里已经命中的不重复列。
        $known = $false
        foreach ($item in $items) {
          if ($item.path -eq $row.path) { $known = $true; break }
        }
        if ($known) { continue }
        $row.match = 'content'
        $items += $row
      }
    } catch {
      # 内容检索失败不算事：名字的结果还在。
    }
  }
  return $items
}

# 跑一条索引查询，吐出 {name, path} 的数组。
function Invoke-Query([string]$sql) {
  $cmd = (Get-Index).CreateCommand()
  $cmd.CommandText = $sql
  $reader = $cmd.ExecuteReader()
  $rows = @()
  while ($reader.Read()) {
    $path = ConvertFrom-ItemUrl ([string]$reader.GetValue(1))
    if ($path -eq '') { continue }
    $rows += @{ name = [string]$reader.GetValue(0); path = $path }
  }
  $reader.Close()
  return $rows
}

# 内容检索用的查询串。
#
# 索引的内容检索用 AQS 语法：词要用双引号包起来，多个词用 AND 连着
# （裸着写多个词会被当成操作符，直接报错）。
function ConvertTo-ContentQuery([string]$query) {
  $tokens = @($query -split '\s+' | Where-Object { $_ -ne '' })
  $parts = @()
  foreach ($token in $tokens) {
    # 双引号是短语边界、圆括号是分组：去掉，免得把查询写坏。
    $clean = $token -replace '["\(\)]', ''
    if ($clean -eq '') { continue }
    $parts += '"' + $clean + '"'
  }
  if ($parts.Count -eq 0) { return '' }
  # 单引号是 SQL 字符串的边界：doubling 一下。
  return (($parts -join ' AND ')).Replace("'", "''")
}

# 抽图标：ExtractAssociatedIcon 会跟着快捷方式找到它指向的程序，
# 文档则会拿到它自己类型的图标。抽不出就返回空（界面上退回符号图标）。
function Get-IconFor([string]$path) {
  try {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
    if ($null -eq $icon) { return '' }
    $bitmap = $icon.ToBitmap()
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    $bitmap.Dispose()
    $stream.Dispose()
    $icon.Dispose()
    return [Convert]::ToBase64String($bytes)
  } catch {
    return ''
  }
}

function Get-Icons([string[]]$paths) {
  $items = @()
  foreach ($path in $paths) {
    $items += @{ path = $path; icon = (Get-IconFor $path) }
  }
  return $items
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = 0
  $op = ''
  try {
    $request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    $id = [int]$request.id
    $op = [string]$request.op
    if ($op -eq 'files') {
      # 用 @() 包住：函数返回空数组时会被摊平掉，不包住就变成 null 了。
      $found = @(Find-Files ([string]$request.query) ([int]$request.limit))
      $response = @{ id = $id; ok = $true; op = $op; items = $found }
    } elseif ($op -eq 'icons') {
      $found = @(Get-Icons ([string[]]$request.paths))
      $response = @{ id = $id; ok = $true; op = $op; items = $found }
    } elseif ($op -eq 'ping') {
      $response = @{ id = $id; ok = $true; op = $op }
    } else {
      $response = @{ id = $id; ok = $false; op = $op; error = "不认识的指令：$op" }
    }
  } catch {
    $response = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  $json = $response | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
  [Console]::Out.Flush()
}
