param(
  [int]$Port = 5566,
  [string]$Root = "$PSScriptRoot\safewalk-app"
)

# Raw TCP server instead of System.Net.HttpListener: HttpListener (via http.sys) validates the
# incoming Host header against registered URL prefixes, which rejects requests forwarded through a
# tunnel (whose Host header is the public tunnel hostname, not "localhost") with 400 Invalid
# Hostname — and registering non-localhost prefixes needs an elevated URL-ACL reservation we don't
# have. A plain TCP listener has no such hostname check, so it works for any Host header untouched.

$mime = @{
  ".html" = "text/html"
  ".js"   = "application/javascript"
  ".css"  = "text/css"
  ".json" = "application/json"
  ".png"  = "image/png"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
$listener.Start()
Write-Host "Serving $Root on port $Port (any hostname/interface)"

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $requestLine = $reader.ReadLine()
    while ($true) {
      $line = $reader.ReadLine()
      if ([string]::IsNullOrEmpty($line)) { break }
    }

    $path = "/index.html"
    if ($requestLine -match '^(GET|HEAD)\s+(\S+)\s+HTTP') {
      $reqPath = $matches[2].Split("?")[0]
      if ($reqPath -ne "/") { $path = [System.Uri]::UnescapeDataString($reqPath) }
    }
    $filePath = Join-Path $Root ($path.TrimStart("/"))

    $headerWriter = New-Object System.IO.StreamWriter($stream)
    $headerWriter.NewLine = "`r`n"
    $headerWriter.AutoFlush = $false

    if ((Test-Path $filePath -PathType Leaf) -and ($filePath.StartsWith($Root))) {
      $ext = [System.IO.Path]::GetExtension($filePath)
      $ct = $mime[$ext]
      if (-not $ct) { $ct = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $headerWriter.WriteLine("HTTP/1.1 200 OK")
      $headerWriter.WriteLine("Content-Type: $ct")
      $headerWriter.WriteLine("Content-Length: $($bytes.Length)")
      $headerWriter.WriteLine("Connection: close")
      $headerWriter.WriteLine("")
      $headerWriter.Flush()
      $stream.Write($bytes, 0, $bytes.Length)
    } else {
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
      $headerWriter.WriteLine("HTTP/1.1 404 Not Found")
      $headerWriter.WriteLine("Content-Type: text/plain")
      $headerWriter.WriteLine("Content-Length: $($msg.Length)")
      $headerWriter.WriteLine("Connection: close")
      $headerWriter.WriteLine("")
      $headerWriter.Flush()
      $stream.Write($msg, 0, $msg.Length)
    }
    $stream.Flush()
  } catch {
  } finally {
    $client.Close()
  }
}
