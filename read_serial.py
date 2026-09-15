import serial
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

s = serial.Serial('COM3', 115200, timeout=1)
time.sleep(2)

# Send STATUS command
s.write(b"STATUS\n")
time.sleep(1)

# Read response
start = time.time()
while time.time() - start < 5:
    if s.in_waiting:
        line = s.readline().decode('utf-8', errors='ignore')
        print(line, end='')
    time.sleep(0.05)

s.close()
