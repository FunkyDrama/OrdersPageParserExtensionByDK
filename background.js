chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "resolveRedirect") {
    const { url } = message;
    chrome.tabs.create({ url, active: false }, (tab) => {
      const tabId = tab.id;
      const listener = (tabIdUpdated, changeInfo, updatedTab) => {
        if (tabIdUpdated === tabId && changeInfo.status === "complete") {
          chrome.tabs.get(tabId, (finalTab) => {
            sendResponse({ finalUrl: finalTab.url });
            chrome.tabs.remove(tabId);
          });
          chrome.tabs.onUpdated.removeListener(listener);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    return true;
  } else if (message.action === "processWayfair") {
    const { inventoryUrl, partNumbers, pageHTML } = message;
    console.log("📥 Получено сообщение в background.js:", message);

    chrome.tabs.create({ url: inventoryUrl, active: false }, (tab) => {
      const tabId = tab.id;
      let wayfairLinks = [];

      const processNextPartNumber = (index) => {
        if (index >= partNumbers.length) {
          saveDataToStorage(wayfairLinks, pageHTML);
          chrome.tabs.remove(tabId);
          console.log("Обработка всех part numbers завершена.");
          return true;
        }

        const currentPartNumber = partNumbers[index];
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: searchSKUInInventory,
            args: [currentPartNumber],
          },
          (results) => {
            if (results && results[0] && results[0].result) {
              const link = results[0].result;
              if (link) {
                wayfairLinks.push(link);
              }
            }
            setTimeout(() => processNextPartNumber(index + 1), 3000);
          }
        );
      };

      chrome.tabs.onUpdated.addListener(function listener(
        tabIdUpdated,
        changeInfo
      ) {
        if (tabIdUpdated === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);

          setTimeout(() => {
            processNextPartNumber(0);
          }, 3000);
        }
      });
    });
    return true;
  } else if (message.action === "processOverstock") {
    const { inventoryUrl, supplierSKUs, pageHTML } = message;
    console.log("📥 Получено сообщение в background.js:", message);

    chrome.tabs.create({ url: inventoryUrl, active: false }, (tab) => {
      const tabId = tab.id;
      let overstockLinks = [];
      let updatedPageHTML = pageHTML;

      const processNextSKU = (index) => {
        if (index >= supplierSKUs.length) {
          saveDataToStorage(overstockLinks, updatedPageHTML);
          chrome.tabs.remove(tabId);
          console.log("✅ Обработка всех SKU завершена.");
          return true;
        }

        const currentSKU = supplierSKUs[index];
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: searchSKUOverstock,
            args: [currentSKU],
          },
          (results) => {
            if (results && results[0] && results[0].result) {
              let res = results[0].result;
              if (!Array.isArray(res)) {
                res = [res];
              }

              res.forEach(({ title, link }) => {
                if (link) {
                  overstockLinks.push(link);

                  updatedPageHTML = updatedPageHTML.replace(
                    new RegExp(
                      `(<div[^>]*style=["'][^"']*color:\\s*#808080[^>]*>\\s*${currentSKU}\\s*</div>)`,
                      "i"
                    ),
                    `$1\n<p class="listing-title">${title}</p>`
                  );

                  console.log(
                    `✅ Добавлен тайтл "${title}" в HTML для SKU ${currentSKU}`
                  );
                }
              });
            } else {
              console.warn("⚠️ Нет результатов для SKU:", currentSKU);
            }
            setTimeout(() => processNextSKU(index + 1), 3000);
          }
        );
      };

      chrome.tabs.onUpdated.addListener(function listener(
        tabIdUpdated,
        changeInfo
      ) {
        if (tabIdUpdated === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(() => {
            processNextSKU(0);
          }, 3000);
        }
      });
    });
    return true;
  }
  sendResponse({ success: true });
  return true;
});

function searchSKUInInventory(sku) {
  const searchField = document.querySelector(
    'input[name="skuAndSupplierPartCombined"]'
  );
  console.log("🔍 Поле поиска найдено?", !!searchField);
  const searchButton = document.querySelector(
    'button[data-test-id="search-input-box-cta"]'
  );
  console.log("🔍 Кнопка поиска найдена?", !!searchButton);

  if (!searchField || !searchButton) {
    console.error("Поле поиска или кнопка не найдены.");
    return null;
  }

  searchField.value = sku;
  searchField.dispatchEvent(new Event("input", { bubbles: true }));

  setTimeout(() => {
    console.log("✅ Нажимаем кнопку поиска...");
    searchButton.click();
  }, 5000);

  return new Promise((resolve) => {
    setTimeout(() => {
      let matchedDiv = null;
      const allPartNumbers = document.querySelectorAll(
        'div[class="_1ja0ee313e   _1ja0ee31bd"]'
      );
      allPartNumbers.forEach((partNumber) => {
        if (partNumber.innerText.trim() === sku) {
          console.log("✅ Полное совпадение найдено:", partNumber.innerText);
          matchedDiv = partNumber.closest('tr[data-test-id="cie-table-row"]');
        }
      });
      const skuButton = matchedDiv.querySelector(
        'tr[data-test-id="cie-table-row"] td:nth-child(3) button[data-hb-id="Button"]'
      );

      if (skuButton) {
        skuButton.click();
        setTimeout(() => {
          const links = document.querySelectorAll(
            'div[data-hb-id="Popover"] a[data-hb-id="Button"]'
          );

          let usLink = null;

          links.forEach((link) => {
            if (link.innerText.includes("Wayfair US")) {
              usLink = link.href;
            }
          });

          if (usLink) {
            console.log("🔗 Найдена ссылка Wayfair US:", usLink);
            resolve(usLink);
          } else {
            console.log("❌ Ссылка Wayfair US не найдена!");
            resolve(null);
          }
        }, 5000);
      } else {
        resolve(null);
      }
    }, 8000);
  });
}

async function searchSKUOverstock(sku) {
  console.log("🔍 Ищем SKU на Overstock:", sku);

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const searchField = document.querySelector(
    'input[placeholder="Search Supplier SKU"]'
  );
  console.log("🔍 Поле поиска найдено?", !!searchField);
  if (!searchField) {
    console.error("❌ Поле поиска не найдено.");
    return null;
  }

  searchField.value = "";
  await new Promise((resolve) => setTimeout(resolve, 500));
  searchField.value = sku;
  searchField.dispatchEvent(new Event("input", { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 5000));

  document.querySelectorAll("div.rt-expander").forEach((expander) => {
    if (!expander.classList.contains("-open")) {
      expander.click();
      console.log("✅ Клик по раскрывающему элементу");
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const rows = document.querySelectorAll(".tr-sub-row");
  let foundLink = null;

  for (const row of rows) {
    const skuCell = row.querySelector(".rt-td:nth-child(5)");
    if (!skuCell) continue;

    const text = skuCell.innerText.trim();
    if (text.includes(sku)) {
      const linkCell = row.querySelector(".rt-td:nth-child(6) a");
      if (linkCell) {
        foundLink = linkCell.href;
        console.log("✅ Найдено совпадение для SKU:", text);
        break;
      }
    }
  }

  // 8. Название берем как раньше
  const titleElement = document.querySelector('.rt-td a[href^="/product/"]');
  const listingTitle = titleElement
    ? titleElement.innerText.trim()
    : "❌ Название не найдено";

  // 9. Собираем результат
  const result = {
    title: listingTitle,
    link: foundLink || "❌ Ссылка не найдена",
  };
  console.log("✅ Результат для SKU", sku, ":", result);
  return result;
}

function saveDataToStorage(wayfairLinks, pageHTML) {
  let linksText = wayfairLinks.map((link) => link + "\n").join("");
  const textBlock = linksText + pageHTML + "\n";

  chrome.storage.local.get("allOrdersData", (result) => {
    const oldData = result.allOrdersData || "";
    const updated = oldData + textBlock;

    chrome.storage.local.set({ allOrdersData: updated }, () => {
      console.log("✅ Данные Wayfair сохранены!");
      chrome.runtime.sendMessage({
        action: "updatePopup",
        text: "Текущий заказ добавлен!",
      });
    });
  });
}
