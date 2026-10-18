// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title EqoraMINR
 * @notice Mock Indian Rupee (mINR) used as the debt asset of the EQORA
 *         practice terminal. 1 mINR = 1 INR by convention. DEMO ONLY —
 *         not a real stablecoin, no redemption, no reserves.
 */
contract EqoraMINR is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 10_000e18;

    /// @notice The pool is allowed to mint borrow proceeds.
    address public minter;

    event MinterSet(address indexed minter);

    constructor() ERC20("Mock Indian Rupee", "mINR") {}

    function setMinter(address minter_) external onlyOwner {
        minter = minter_;
        emit MinterSet(minter_);
    }

    /// @notice Anyone can claim demo rupees for the practice terminal.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter || msg.sender == owner(), "not minter");
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
