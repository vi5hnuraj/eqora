// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title EqoraBorrowWindow
 * @notice Borrowing is only allowed during exchange trading hours.
 *         Defaults: NSE, Monday–Friday, 09:15–15:30 IST (UTC+5:30).
 *         Supply / repay / withdraw stay open 24/7 — only new borrowing
 *         is gated to the live oracle window.
 */
contract EqoraBorrowWindow is Ownable {
    uint256 public constant IST_OFFSET = 19800; // 5h30m in seconds
    uint256 public constant DAY = 86400;

    uint32 public startMinute; // minute-of-day, IST
    uint32 public endMinute; // exclusive, minute-of-day, IST

    event WindowSet(uint32 startMinute, uint32 endMinute);

    constructor() {
        startMinute = uint32(9 * 60 + 15); // 09:15
        endMinute = uint32(15 * 60 + 30); // 15:30
        emit WindowSet(startMinute, endMinute);
    }

    function setWindow(uint32 startMinute_, uint32 endMinute_) external onlyOwner {
        require(startMinute_ < endMinute_, "invalid window");
        require(endMinute_ <= 1440, "day overflow");
        startMinute = startMinute_;
        endMinute = endMinute_;
        emit WindowSet(startMinute_, endMinute_);
    }

    function canBorrow() external view returns (bool) {
        return canBorrowAt(block.timestamp);
    }

    function canBorrowAt(uint256 timestamp) public view returns (bool) {
        uint256 ist = timestamp + IST_OFFSET;
        uint32 minuteOfDay = uint32((ist % DAY) / 60);
        if (minuteOfDay < startMinute || minuteOfDay >= endMinute) {
            return false;
        }
        // Epoch (1970-01-01) was a Thursday: days % 7 -> 0=Thu 1=Fri 2=Sat
        // 3=Sun 4=Mon 5=Tue 6=Wed. Trading days are Mon-Fri.
        uint256 weekday = (ist / DAY) % 7;
        return weekday == 0 || weekday == 1 || weekday == 4 || weekday == 5 || weekday == 6;
    }
}
