Add-Type -AssemblyName System.Drawing

$src = "assets\rakyat-review-logo.png"
$backup = ".backups\rakyat-review-logo-orig.png"

if (-not (Test-Path $backup)) {
    Copy-Item $src $backup
}

$origImg = [System.Drawing.Image]::FromFile($src)
$width = 288
$height = 192

$target = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($target)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

$graphics.DrawImage($origImg, 0, 0, $width, $height)
$origImg.Dispose()
$graphics.Dispose()

$target.Save("assets\rakyat-review-logo-opt.png", [System.Drawing.Imaging.ImageFormat]::Png)
$target.Dispose()

$origBytes = (Get-Item $src).Length
$optBytes = (Get-Item "assets\rakyat-review-logo-opt.png").Length

Write-Output "Original bytes: $origBytes"
Write-Output "Optimized bytes: $optBytes"
Write-Output "Savings: $([math]::Round(($origBytes - $optBytes)/$origBytes * 100, 2))%"
