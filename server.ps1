param(
  [int]$Port = 5566,
  [string]$Root = "$PSScriptRoot\safewalk-app",
  # Diagnostic only: writes requests.log, so a device reporting "nothing shows up" can be traced
  # to the build it actually fetched rather than guessed at.
  [switch]$LogRequests
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
    # This loop handles one connection at a time, so a socket that opens and then says nothing would
    # block every other request forever. Browsers do exactly that routinely — speculative preconnect
    # sockets are opened and left idle — and without these timeouts the server wedges with a pile of
    # CLOSE_WAIT connections and stops answering entirely.
    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 5000

    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrEmpty($requestLine)) { continue }  # preconnect with no request; drop it
    $headerLines = New-Object System.Collections.Generic.List[string]
    while ($true) {
      $line = $reader.ReadLine()
      if ([string]::IsNullOrEmpty($line)) { break }
      $headerLines.Add($line)
    }

    # Request log. Off unless -LogRequests is passed, because the normal case does not need it —
    # but when someone reports "the app shows nothing on my phone" there is otherwise no way to
    # tell whether their device fetched the current build, an old cached one, or never arrived.
    if ($LogRequests) {
      $ua = ($headerLines | Where-Object { $_ -match '^User-Agent:' }) -replace '^User-Agent:\s*', ''
      $short = if ($ua -match 'iPhone|iPad') { 'iOS' } elseif ($ua -match 'Android') { 'Android' } else { 'other' }
      "{0}  {1}  [{2}]" -f (Get-Date -Format 'HH:mm:ss'), $requestLine, $short |
        Out-File -FilePath "$PSScriptRoot\requests.log" -Append -Encoding utf8
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
      # Dev server: never let a stale copy be cached, or you end up debugging the previous build.
      $headerWriter.WriteLine("Cache-Control: no-store, must-revalidate")
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
