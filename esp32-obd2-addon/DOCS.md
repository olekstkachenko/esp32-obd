# Повна документація ESP32 OBD2 Telemetry & WebApp 🚗📊🏠

Ласкаво просимо до повної документації додатку **ESP32 OBD2 Telemetry & WebApp** для **Home Assistant**!

---

## 📑 Зміст

1. [Огляд та принцип роботи](#1-огляд-та-принцип-роботи)
2. [Параметри конфігурації додатку](#2-параметри-конфігурації-додатку)
3. [Налаштування Telegram-бота](#3-налаштування-telegram-бота)
4. [Налаштування та прошивка ESP32](#4-налаштування-та-прошивка-esp32)
5. [Інтеграція в Home Assistant (Сенсори та Картки)](#5-інтеграція-в-home-assistant)
6. [Корисні автоматизації в Home Assistant](#6-корисні-автоматизації)
7. [Довідник REST API](#7-довідник-rest-api)
8. [Усунення несправностей (FAQ)](#8-усунення-несправностей-faq)

---

## 1. Огляд та принцип роботи

Система працює повністю в автоматичному режимі:
1. **ESP32** при включенні запалювання авто підключається по Bluetooth до сканера **ELM327**.
2. Зчитуються показники: **швидкість (km/h)**, **оберти двигуна (RPM)**, **температура антифризу (°C)**, **напруга бортової мережі (В)** та **MAF (розхід палива)**.
3. Дані передаються через Wi-Fi на сервер Home Assistant.
4. Якщо телефон з точкою доступу вимкнений, ESP32 зберігає поїздку в **офлайн-буфер RAM** (до ~30 хв безперервного руху) і відправляє всі точки пакетом (`/api/obd/batch`) при підключенні до інтернету.
5. Сервер у Home Assistant автоматично групує точки в поїздки, веде історію, підраховує витрату пального, вартість за поточними цінами на АЗС та відправляє сповіщення у Telegram.

---

## 2. Параметри конфігурації додатку

У вкладці **Конфігурація (Configuration)** додатку доступні такі параметри:

| Параметр | Тип | За замовчуванням | Опис |
|---|---|---|---|
| `telegram_bot_token` | `string` | `""` (пусто) | Токен вашого Telegram-бота, отриманий від `@BotFather`. Якщо вказано, бот надсилатиме сповіщення та звіти. |
| `webapp_url` | `string` | `""` (пусто) | Публічний HTTPS URL вашого додатку (наприклад, ваш Ngrok-домен або Cloudflare) для відкриття WebApp у Telegram. |
| `ngrok_authtoken` | `string` | `""` (пусто) | Ваш Auth Token від [ngrok.com](https://ngrok.com) для автоматичного запуску тунелю безпосередньо всередині Home Assistant. |
| `ngrok_domain` | `string` | `""` (пусто) | Статичний домен Ngrok (наприклад: `your-subdomain.ngrok-free.dev`). Якщо пусто, створиться випадковий домен. |
| `port` | `integer` | `3000` | Внутрішній/зовнішній TCP-порт сервера для прийому HTTP-запитів від ESP32. |

---

## 3. Налаштування Telegram-бота

Щоб отримувати сповіщення про завершені поїздки та відкривати додаток прямо з Telegram:

1. Відкрийте [@BotFather](https://t.me/BotFather) у Telegram та створіть нового бота командою `/newbot`.
2. Скопіюйте виданий токен (наприклад, `7123456789:AAH...`) і вставте його в поле `telegram_bot_token` у конфігурації аддону.
3. Налаштуйте веб-кнопку Mini App у `@BotFather`:
   - Надішліть команду `/setmenubutton`.
   - Оберіть вашого бота.
   - Введіть назву кнопки (наприклад, `🚗 OBD2 Дашборд`).
   - Вкажіть публічну адресу вашого сервера (наприклад, `https://ваш-тунель.trycloudflare.com/`).

---

## 4. Налаштування та прошивка ESP32

Прошивка знаходиться в репозиторії в папці `esp32-obd2/`.

У файлі `esp32-obd2/src/main.cpp` перевірте параметри:

```cpp
// 1. Дані вашої точки доступу Wi-Fi (наприклад, роздача з телефону в авто):
const char* ssid = "MyCar_WiFi";
const char* password = "your_wifi_password";

// 2. Адреса сервера Home Assistant:
// Якщо ESP32 підключається до домашнього Wi-Fi:
const char* serverUrlBase = "http://192.168.1.XXX:3000/api/obd";

// Або якщо через 4G/LTE точку доступу (використовуйте публічний тунель):
const char* serverUrlBase = "https://ваш-домен.trycloudflare.com/api/obd";

// 3. Bluetooth сканер ELM327:
const char* elmName = "OBDII";
const char* elmPin = "1234";
```

> [!TIP]
> У `platformio.ini` автоматично встановлено параметр `board_build.partitions = huge_app.csv`, оскільки суміщення Bluetooth Classic та Wi-Fi/SSL вимагає розширеного розділу пам'яті програми (до 3.1 МБ).

---

## 5. Інтеграція в Home Assistant

Ви можете створити нативні сенсори вашого авто в Home Assistant.

### Крок 1: Додайте сенсори у `configuration.yaml`

Відкрийте файл `configuration.yaml` у Home Assistant та додайте наступний блок:

```yaml
sensor:
  - platform: rest
    name: "Car OBD2 Telemetry"
    resource: "http://localhost:3000/api/data"
    scan_interval: 5
    json_attributes_path: "$.latest"
    json_attributes:
      - speed
      - rpm
      - temp
      - voltage
      - fuel_rate
    value_template: "{{ value_json.latest.speed | default(0) | round(0) }}"
    unit_of_measurement: "km/h"

  - platform: rest
    name: "Car Active Trip"
    resource: "http://localhost:3000/api/data"
    scan_interval: 10
    json_attributes_path: "$.trip"
    json_attributes:
      - distance_km
      - avg_speed
      - max_speed
    value_template: "{{ value_json.trip.distance_km | default(0) | round(1) }}"
    unit_of_measurement: "km"

template:
  - sensor:
      - name: "Car Engine RPM"
        state: "{{ state_attr('sensor.car_obd2_telemetry', 'rpm') | default(0) | round(0) }}"
        unit_of_measurement: "RPM"
        icon: "mdi:engine"

      - name: "Car Coolant Temp"
        state: "{{ state_attr('sensor.car_obd2_telemetry', 'temp') | default(0) | round(0) }}"
        unit_of_measurement: "°C"
        device_class: temperature
        icon: "mdi:coolant-temperature"

      - name: "Car Battery Voltage"
        state: "{{ state_attr('sensor.car_obd2_telemetry', 'voltage') | default(0) | round(1) }}"
        unit_of_measurement: "V"
        device_class: voltage
        icon: "mdi:car-battery"

      - name: "Car Fuel Rate"
        state: "{{ state_attr('sensor.car_obd2_telemetry', 'fuel_rate') | default(0) | round(1) }}"
        unit_of_measurement: "L/h"
        icon: "mdi:gas-station"

      - name: "Car Trip Average Speed"
        state: "{{ state_attr('sensor.car_active_trip', 'avg_speed') | default(0) | round(0) }}"
        unit_of_measurement: "km/h"
        icon: "mdi:speedometer-slow"
```

---

### Крок 2: Приклади карток для Lovelace Dashboard

#### 🏎️ Картка приладів (Gauge Cards):
```yaml
type: horizontal-stack
cards:
  - type: gauge
    entity: sensor.car_obd2_telemetry
    name: Швидкість
    min: 0
    max: 180
    needle: true
    severity:
      green: 0
      yellow: 90
      red: 130

  - type: gauge
    entity: sensor.car_engine_rpm
    name: Оберти RPM
    min: 0
    max: 6000
    needle: true
    severity:
      green: 0
      yellow: 3500
      red: 5000
```

#### 🔋 Стан акумулятора та температури:
```yaml
type: entities
title: 🚗 Телеметрія автомобіля
show_header_toggle: false
entities:
  - entity: sensor.car_battery_voltage
    name: Напруга АКБ
  - entity: sensor.car_coolant_temp
    name: Температура двигуна
  - entity: sensor.car_fuel_rate
    name: Миттєва витрата
  - entity: sensor.car_active_trip
    name: Дистанція поточної поїздки
```

---

## 6. Корисні автоматизації

### ⚠️ Сповіщення: Низька напруга акумулятора авто
```yaml
alias: "Авто: Низький заряд АКБ"
trigger:
  - platform: numeric_state
    entity_id: sensor.car_battery_voltage
    below: 11.8
    for:
      minutes: 1
action:
  - service: notify.persistent_notification
    data:
      title: "🪫 Увага: Акумулятор авто розряджений"
      message: "Напруга впала до {{ states('sensor.car_battery_voltage') }} В. Можливо, варто підзарядити АКБ."
```

### 🌡️ Сповіщення: Перегрів двигуна
```yaml
alias: "Авто: Перегрів двигуна"
trigger:
  - platform: numeric_state
    entity_id: sensor.car_coolant_temp
    above: 105
action:
  - service: notify.persistent_notification
    data:
      title: "🔥 УВАГА: Перегрів двигуна!"
      message: "Температура ОР становить {{ states('sensor.car_coolant_temp') }}°C. Зупиніть рух та перевірте рівень рідини."
```

---

## 7. Довідник REST API

| Метод | Шлях | Опис |
|---|---|---|
| `POST` | `/api/obd` | Приймає окремий запис телеметрії від ESP32 `{rpm, speed, temp, voltage, fuel_rate}`. |
| `POST` | `/api/obd/batch` | Приймає масив офлайн-буферизованих точок `{records: [...]}`. |
| `GET` | `/api/data` | Повертає останні показання та поточну активну поїздку. |
| `GET` | `/api/history` | Повертає останні 60 точок для побудови Live-графіків швидкості та RPM. |
| `GET` | `/api/trips` | Повертає архів усіх поїздок із розрахованою дистанцією, витратою пального та вартістю. |
| `GET` | `/api/trips/:id` | Детальна інформація та повний масив точок конкретної поїздки. |
| `DELETE`| `/api/trips/:id` | Видалення поїздки з архіву. |
| `POST` | `/api/trips/finish` | Примусове завершення поточної сесії. |
| `GET` | `/api/fuel-prices` | Список актуальних цін А-95 на АЗС (OKKO, WOG, UPG, KLO, Ukrnafta). |
| `POST` | `/api/fuel-prices/refresh` | Примусовий запуск парсера цін АЗС. |
| `GET` | `/api/settings` | Отримання налаштувань (ціна пального). |
| `POST` | `/api/settings` | Оновлення збереженої ціни пального `{fuel_price: 82.90}`. |
| `POST` | `/api/device/log` | Прийом логів та діагностичних статусів від ESP32. |
| `GET` | `/api/device/status` | Отримання останніх логів та статусу з'єднання ESP32 з ELM327. |

---

## 8. Усунення несправностей (FAQ)

### ❓ Де зберігається база даних і чи видалиться вона при оновленні?
База даних `obd_data.db` зберігається у захищеному розділі `/data` Home Assistant. Вона **ніколи не стирається** при оновленні чи перезапуску аддону.

### ❓ ESP32 не підключається до сервера:
- Перевірте, чи порт `3000` вказано у налаштуваннях аддону.
- Якщо ESP32 підключається через домашній Wi-Fi, переконайтеся, що IP-адреса Home Assistant вказана правильно.
- Якщо підключення йде через 4G/LTE точку доступу телефону, використовуйте зовнішній тунель (наприклад, Cloudflare Tunnel або Nabu Casa).

### ❓ Як змінити ціну пального?
Ви можете змінити ціну:
- Прямо у вкладці **«Ціни АЗС»** або на головному екрані дашборду Ingress.
- Або обравши АЗС зі списку (OKKO, WOG, UPG, KLO, Ukrnafta) та натиснувши **«🎯 Застосувати»**.
