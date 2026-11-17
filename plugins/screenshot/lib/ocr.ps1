$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  try {
    $t.Wait(-1) | Out-Null
  } catch {
    # WinRT 的错误都裹在 AggregateException 里：**扒到最里面那句**，
    # 不然 PowerShell 只会说「发生一个或多个错误」，看不出是什么错。
    $err = $_.Exception
    while ($err.InnerException) { $err = $err.InnerException }
    throw $err.Message
  }
  $t.Result
}

$path = $env:OCR_FILE
$tags = @($env:OCR_LANGS -split ',' | Where-Object { $_ })

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
# **要 BGRA8 + 不透明**：解码器默认给的格式带 alpha，OCR 不收。
$bitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lines = @()
foreach ($tag in $tags) {
  $lang = [Windows.Globalization.Language]::new($tag)
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  if ($null -eq $engine) { continue }
  $r = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  foreach ($line in $r.Lines) {
    $words = @()
    foreach ($w in $line.Words) {
      $b = $w.BoundingRect
      $words += ,@{ text = $w.Text; x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height }
    }
    $lines += ,@{ lang = $tag; text = $line.Text; words = $words }
  }
}
@{ lines = $lines } | ConvertTo-Json -Depth 6 -Compress
